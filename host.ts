// Provider bridge for the Grok usage provider (see lib/grok-provider.ts).
// Maintenance requests (health, usage) go to lib/grok-usage.ts; everything
// else goes to bb's ACP bridge, so threads on this provider run Grok Build.
// From bb-plugin-grok-build-usage by MacHatter1 (MIT).

import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import {
  createBridgeIo,
  experimental_defineProviderBridge,
  type ProviderBridgeEntry,
} from "@get-bb/plugin-sdk/provider-bridge";
import { experimental_acpProviderBridge } from "@get-bb/plugin-sdk/provider-bridge/acp";

import { grokSessionContract, renewGrokSession } from "./lib/grok-session";
import { readGrokHealth, readGrokUsage } from "./lib/grok-usage";

const { sendResult, sendError } = createBridgeIo();
const MAINTENANCE_METHODS = new Set(["provider/health", "provider/usage"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function handleLine(line: string): void {
  const trimmed = line.trim();
  if (trimmed === "") return;

  let message: unknown;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }

  if (
    !isRecord(message) ||
    typeof message.method !== "string" ||
    !MAINTENANCE_METHODS.has(message.method) ||
    message.id === undefined
  ) {
    experimental_acpProviderBridge.handleLine(line);
    return;
  }

  void handleMaintenanceRequest(message).catch((error: unknown) => {
    sendError(
      message.id as string | number,
      -32603,
      error instanceof Error ? error.message : "Grok Build maintenance request failed",
    );
  });
}

async function handleMaintenanceRequest(message: Record<string, unknown>): Promise<void> {
  const params = isRecord(message.params) ? message.params : {};
  const providerOptions = params.providerOptions;
  const result = message.method === "provider/health"
    ? await readGrokHealth(providerOptions)
    : await readGrokUsage(providerOptions);
  sendResult(message.id as string | number, result);
}

export const experimental_providerBridge: ProviderBridgeEntry = experimental_defineProviderBridge({
  handleLine,
  start: (context) => experimental_acpProviderBridge.start?.(context),
  onClose: () => experimental_acpProviderBridge.onClose?.(),
  onSigterm: () => experimental_acpProviderBridge.onSigterm?.(),
  onSigint: () => experimental_acpProviderBridge.onSigint?.(),
});

export default experimental_defineHostEntry({
  contract: grokSessionContract,
  handlers: {
    renewGrokSession: (input) => renewGrokSession(input),
  },
});

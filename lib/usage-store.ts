// Shared client-side usage store. Works outside React (content script) and
// inside React (disclosure) so both surfaces show one snapshot.
import type { UsageSnapshot } from "../server";
import type { Tone } from "./pace";

export const PLUGIN_ID = "usage-pace";
const RPC_URL = `/api/v1/plugins/${PLUGIN_ID}/rpc/getUsage`;

export interface UsageState {
  data: UsageSnapshot | null;
  error: string | null;
  loading: boolean;
}

let state: UsageState = { data: null, error: null, loading: false };
const listeners = new Set<() => void>();
let inflight: Promise<void> | null = null;

export function getUsageState(): UsageState {
  return state;
}

export function subscribeUsage(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function setState(next: UsageState) {
  state = next;
  for (const listener of listeners) listener();
}

function errorMessage(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const error = Reflect.get(body, "error");
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null) {
    const message = Reflect.get(error, "message");
    if (typeof message === "string") return message;
  }
  const message = Reflect.get(body, "message");
  return typeof message === "string" ? message : null;
}

export function refreshUsage(
  options: { force?: boolean; signal?: AbortSignal } = {},
): Promise<void> {
  if (inflight !== null) return inflight;
  setState({ ...state, loading: true });
  inflight = (async () => {
    try {
      const response = await fetch(RPC_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ force: options.force === true }),
        signal: options.signal,
      });
      const body: unknown = await response.json();
      const ok =
        typeof body === "object" &&
        body !== null &&
        Reflect.get(body, "ok") === true;
      if (!response.ok || !ok) {
        throw new Error(errorMessage(body) ?? "Usage could not be loaded.");
      }
      setState({
        data: Reflect.get(body as object, "result") as UsageSnapshot,
        error: null,
        loading: false,
      });
    } catch (cause) {
      if (options.signal?.aborted === true) {
        setState({ ...state, loading: false });
        return;
      }
      setState({
        ...state,
        error: cause instanceof Error ? cause.message : String(cause),
        loading: false,
      });
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

// --- UI coordination between the content script and the overlay slot ------

type Listener = () => void;

let barHost: HTMLElement | null = null;
const barHostListeners = new Set<Listener>();
export function getBarHost(): HTMLElement | null {
  return barHost;
}
export function setBarHost(next: HTMLElement | null) {
  if (barHost === next) return;
  barHost = next;
  for (const listener of barHostListeners) listener();
}
export function subscribeBarHost(listener: Listener): () => void {
  barHostListeners.add(listener);
  return () => {
    barHostListeners.delete(listener);
  };
}

let overlayOpen = false;
const overlayListeners = new Set<Listener>();
export function isOverlayOpen(): boolean {
  return overlayOpen;
}
export function setOverlayOpen(next: boolean) {
  if (overlayOpen === next) return;
  overlayOpen = next;
  for (const listener of overlayListeners) listener();
}
export function subscribeOverlay(listener: Listener): () => void {
  overlayListeners.add(listener);
  return () => {
    overlayListeners.delete(listener);
  };
}

/** Top unit only: "6d", "16h", "26m". */
export function formatResetShort(resetsAt: string | null, now = Date.now()): string {
  if (resetsAt === null) return "";
  const ms = new Date(resetsAt).getTime() - now;
  if (!Number.isFinite(ms)) return "";
  if (ms <= 0) return "now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes >= 1440) return `${Math.floor(minutes / 1440)}d`;
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h`;
  return `${minutes}m`;
}

export function formatReset(resetsAt: string | null, now = Date.now()): string {
  if (resetsAt === null) return "";
  const ms = new Date(resetsAt).getTime() - now;
  if (!Number.isFinite(ms)) return "";
  if (ms <= 0) return "resets now";
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function toneColor(tone: Tone): string {
  switch (tone) {
    case "critical":
      return "var(--destructive, #dc2626)";
    case "warning":
      return "var(--warning-text, #d97706)";
    default:
      return "var(--primary, currentColor)";
  }
}

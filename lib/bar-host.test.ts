// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BAR_HOST_ID, mountBarHost } from "./bar-host";
import { getBarHost } from "./usage-store";

/** jsdom has no ResizeObserver: record targets and deliver entries by hand. */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  readonly targets = new Set<Element>();
  disconnected = false;
  constructor(private readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }
  observe(target: Element) {
    this.targets.add(target);
  }
  unobserve(target: Element) {
    this.targets.delete(target);
  }
  disconnect() {
    this.targets.clear();
    this.disconnected = true;
  }
  /** Deliver a notification, as the browser does after layout. */
  deliver(target: Element, width: number, withBoxSize = true) {
    const entry = {
      target,
      contentRect: { width } as DOMRectReadOnly,
      borderBoxSize: withBoxSize ? [{ inlineSize: width, blockSize: 40 }] : undefined,
    } as unknown as ResizeObserverEntry;
    this.callback([entry], this as unknown as ResizeObserver);
  }
}

const mutationsFlushed = () => new Promise((resolve) => setTimeout(resolve, 0));
const hostEl = () => document.getElementById(BAR_HOST_ID);

function addFooter(parent: Element = document.body) {
  const footer = document.createElement("div");
  footer.dataset.sidebar = "footer";
  footer.innerHTML = '<ul data-sidebar="menu"><li>icons</li></ul>';
  parent.append(footer);
  return footer;
}

let controller: AbortController;
let unmount: (() => void) | null;
let rect: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  FakeResizeObserver.instances = [];
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  // Keep refreshUsage pending: this suite covers placement, not data.
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
  rect = vi.spyOn(Element.prototype, "getBoundingClientRect");
  document.body.innerHTML = "";
  controller = new AbortController();
  unmount = null;
});

afterEach(() => {
  controller.abort();
  unmount?.();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mount() {
  unmount = mountBarHost({ signal: controller.signal });
  return FakeResizeObserver.instances.at(-1)!;
}

describe("mountBarHost", () => {
  it("puts the container first in the footer and observes only the footer", () => {
    const footer = addFooter();
    const resize = mount();
    const host = hostEl()!;
    expect(footer.firstChild).toBe(host);
    expect(getBarHost()).toBe(host);
    expect(host.style.display).toBe("block");
    expect(host.style.minWidth).toBe("0px");
    expect([...resize.targets]).toEqual([footer]);
  });

  it("does not read layout when unrelated DOM mutates", async () => {
    const footer = addFooter();
    const resize = mount();
    resize.deliver(footer, 256);
    rect.mockClear();
    for (let i = 0; i < 20; i += 1) {
      document.body.append(document.createElement("span"));
      footer.querySelector("li")!.append(document.createElement("i"));
      await mutationsFlushed();
    }
    expect(rect).not.toHaveBeenCalled();
    expect(footer.firstChild).toBe(hostEl());
    expect(hostEl()!.style.display).toBe("block");
    expect([...resize.targets]).toEqual([footer]);
  });

  it("hides on a narrow or hidden footer and shows again when it widens", () => {
    const footer = addFooter();
    const resize = mount();
    resize.deliver(footer, 48);
    expect(hostEl()!.style.display).toBe("none");
    resize.deliver(footer, 256);
    expect(hostEl()!.style.display).toBe("block");
    resize.deliver(footer, 0);
    expect(hostEl()!.style.display).toBe("none");
    resize.deliver(footer, 120);
    expect(hostEl()!.style.display).toBe("block");
  });

  it("falls back to the bounding box when the entry has no border-box size", () => {
    const footer = addFooter();
    const resize = mount();
    rect.mockReturnValue({ width: 60 } as DOMRect);
    resize.deliver(footer, 60, false);
    expect(hostEl()!.style.display).toBe("none");
  });

  it("hides inside a collapsed sidebar whatever its width", async () => {
    const wrapper = document.createElement("div");
    wrapper.dataset.state = "expanded";
    document.body.append(wrapper);
    const footer = addFooter(wrapper);
    const resize = mount();
    resize.deliver(footer, 256);
    expect(hostEl()!.style.display).toBe("block");
    wrapper.dataset.state = "collapsed";
    document.body.append(document.createElement("span"));
    await mutationsFlushed();
    expect(hostEl()!.style.display).toBe("none");
    wrapper.dataset.state = "expanded";
    resize.deliver(footer, 256);
    expect(hostEl()!.style.display).toBe("block");
  });

  it("follows a remounted footer and ignores the old one", async () => {
    const first = addFooter();
    const resize = mount();
    resize.deliver(first, 256);
    first.remove();
    await mutationsFlushed();
    expect(hostEl()).toBeNull();
    expect(getBarHost()).toBeNull();
    expect(resize.targets.size).toBe(0);

    const second = addFooter();
    await mutationsFlushed();
    expect(second.firstChild).toBe(hostEl());
    expect(getBarHost()).toBe(hostEl());
    expect([...resize.targets]).toEqual([second]);
    // A notification queued for the removed footer changes nothing.
    resize.deliver(first, 10);
    expect(hostEl()!.style.display).toBe("block");
    resize.deliver(second, 40);
    expect(hostEl()!.style.display).toBe("none");
  });

  it("stays first when the footer is reparented or content is put before it", async () => {
    const footer = addFooter();
    const resize = mount();
    const next = document.createElement("section");
    document.body.append(next);
    next.append(footer);
    await mutationsFlushed();
    expect(footer.firstChild).toBe(hostEl());
    expect([...resize.targets]).toEqual([footer]);

    footer.insertBefore(document.createElement("div"), footer.firstChild);
    await mutationsFlushed();
    expect(footer.firstChild).toBe(hostEl());
    expect(footer.querySelectorAll(`#${BAR_HOST_ID}`)).toHaveLength(1);
  });

  it("waits for a footer that mounts later", async () => {
    const resize = mount();
    expect(hostEl()).toBeNull();
    expect(getBarHost()).toBeNull();
    const footer = addFooter();
    await mutationsFlushed();
    expect(footer.firstChild).toBe(hostEl());
    expect([...resize.targets]).toEqual([footer]);
  });

  it("disposes its observers and container", async () => {
    const footer = addFooter();
    const resize = mount();
    unmount!();
    unmount = null;
    expect(resize.disconnected).toBe(true);
    expect(hostEl()).toBeNull();
    expect(getBarHost()).toBeNull();
    addFooter();
    footer.remove();
    await mutationsFlushed();
    expect(hostEl()).toBeNull();
    resize.deliver(footer, 256);
    expect(hostEl()).toBeNull();
  });
});

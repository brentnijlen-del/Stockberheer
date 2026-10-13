export class CameraScanner {
  constructor({
    factory,
    media = navigator.mediaDevices,
    secure = window.isSecureContext,
    onStatus = () => {},
  }) {
    this.factory = factory;
    this.media = media;
    this.secure = secure;
    this.onStatus = onStatus;
    this.generation = 0;
    this.instance = null;
    this.starting = null;
  }
  async start(reader, onCode) {
    await this.stop();
    const generation = ++this.generation;
    if (!this.secure || !this.media?.getUserMedia)
      throw new Error("Camera vereist HTTPS en cameratoegang.");
    const scanner = this.factory(reader);
    this.instance = scanner;
    const success = (text) => {
      if (generation === this.generation) {
        onCode(text);
        this.stop();
      }
    };
    this.starting = (async () => {
      try {
        await scanner.start(
          { facingMode: { exact: "environment" } },
          {
            fps: 10,
            qrbox: (w, h) => ({
              width: Math.min(260, w - 20),
              height: Math.min(180, h - 20),
            }),
          },
          success,
          () => {},
        );
      } catch (first) {
        if (generation !== this.generation) throw first;
        await scanner.start(
          { facingMode: "environment" },
          { fps: 10 },
          success,
          () => {},
        );
      }
    })();
    try {
      await this.starting;
      if (generation !== this.generation) {
        await this.release(scanner);
        return;
      }
      this.onStatus("Richt de camera op de QR- of barcode.");
    } catch (e) {
      await this.release(scanner);
      if (generation !== this.generation) return;
      if (this.instance === scanner) this.instance = null;
      throw e;
    } finally {
      if (this.instance === scanner) this.starting = null;
    }
  }
  async release(scanner) {
    try {
      await scanner.stop();
    } catch {}
    try {
      await scanner.clear();
    } catch {}
  }
  async stop() {
    ++this.generation;
    const scanner = this.instance,
      starting = this.starting;
    this.instance = null;
    this.starting = null;
    // Permission prompts cannot be aborted. Do not block navigation: start() releases any late stream.
    if (!starting && scanner) await this.release(scanner);
  }
}
export function hardwareListener({
  onCode,
  active,
  clock = () => performance.now(),
}) {
  let buffer = "",
    last = 0;
  return (event) => {
    if (
      !active() ||
      event.ctrlKey ||
      event.altKey ||
      event.metaKey ||
      event.isComposing
    )
      return;
    const target = event.target;
    if (
      target?.closest?.("#login") ||
      target?.tagName === "TEXTAREA" ||
      (target?.matches?.("input,select") && !target?.matches?.("[data-scan]"))
    ) {
      buffer = "";
      return;
    }
    const now = clock();
    if (event.key === "Enter") {
      const code = buffer;
      buffer = "";
      if (now - last > 120 || code.length < 3) return;
      event.preventDefault();
      onCode(code, target);
      return;
    }
    if (event.key.length !== 1) return;
    if (now - last > 120) buffer = "";
    last = now;
    buffer += event.key;
  };
}

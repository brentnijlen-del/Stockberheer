export class MaterialService {
  constructor(
    auth,
    { fetchImpl = fetch, onStatus = () => {}, timeout = 15000 } = {},
  ) {
    this.auth = auth;
    this.fetch = (...args) => fetchImpl(...args);
    this.onStatus = onStatus;
    this.timeout = timeout;
    this.epoch = 0;
    this.user = null;
    this.controllers = new Set();
    this.busy = false;
    this.pending = null;
  }
  activate(user) {
    this.invalidate();
    this.user = user;
  }
  invalidate() {
    this.epoch++;
    this.user = null;
    this.pending = null;
    this.busy = false;
    for (const c of this.controllers) c.abort();
    this.controllers.clear();
  }
  call(path, body, epoch = this.epoch) {
    return this.request("/rest/v1/rpc/" + path, body, epoch);
  }
  edge(body) {
    return this.request("/functions/v1/user-management", body);
  }
  pin(body) {
    return this.request("/functions/v1/pin-auth", body);
  }
  async request(path, body, epoch = this.epoch) {
    const user = this.user;
    if (!user) throw new Error("Meld eerst aan.");
    const { data, error } = await this.auth.getSession();
    if (error) throw error;
    if (
      epoch !== this.epoch ||
      this.user !== user ||
      data.session?.user.id !== user
    )
      throw new Error("Sessie gewijzigd; handeling geannuleerd.");
    const controller = new AbortController();
    this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const response = await this.fetch(`${this.url}${path}`, {
        method: "POST",
        headers: {
          apikey: this.key,
          Authorization: `Bearer ${data.session.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const result = await response.json();
      if (epoch !== this.epoch || this.user !== user)
        throw new Error("Sessie gewijzigd; antwoord genegeerd.");
      if (!response.ok) {
        const e = new Error(result.message || "Aanvraag mislukt.");
        e.code = result.code;
        e.status = response.status;
        throw e;
      }
      return result;
    } finally {
      clearTimeout(timer);
      this.controllers.delete(controller);
    }
  }
  snapshot() {
    return this.call("material_snapshot", {});
  }
  async command(type, payload, { retry = false } = {}) {
    if (this.busy) throw new Error("Wacht tot de vorige handeling klaar is.");
    if (this.pending && !retry)
      throw new Error("Controleer of herhaal eerst de vorige handeling.");
    const epoch = this.epoch;
    const request = retry
      ? this.pending
      : {
          command: { type, payload: structuredClone(payload) },
          request_id: crypto.randomUUID(),
        };
    if (!request) throw new Error("Geen handeling om opnieuw te proberen.");
    this.busy = true;
    this.pending = request;
    this.onStatus("saving", "Bezig met opslaan…");
    try {
      const result = await this.call("material_command", request, epoch);
      if (epoch !== this.epoch)
        throw new Error("Sessie gewijzigd; antwoord genegeerd.");
      if (result?.saved !== true) throw new Error("Opslag is niet bevestigd.");
      this.pending = null;
      this.onStatus("saved", "Opgeslagen.");
      return result;
    } catch (error) {
      if (epoch === this.epoch) {
        if (
          error.status &&
          ((error.status < 500 && error.status !== 408) ||
            /^(22|23|40|42|P0)/.test(error.code || ""))
        ) {
          this.pending = null;
          this.onStatus("error", `Niet opgeslagen: ${error.message}`);
        } else
          this.onStatus(
            "uncertain",
            "Opslag niet bevestigd. Herhaal veilig dezelfde handeling zodra de verbinding terug is.",
          );
      }
      throw error;
    } finally {
      if (epoch === this.epoch) this.busy = false;
    }
  }
}

/** Minimal browser-level CDP connection. Page automation stays in upstream MCP. */
export class Cdp {
  private next = 0
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>()
  private constructor(private socket: WebSocket) {
    Cdp.listen(this, socket)
  }

  private static listen(client: Cdp, socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      if (client.socket !== socket) return
      const message = JSON.parse(String(event.data))
      const request = client.pending.get(message.id)
      if (!request) return
      client.pending.delete(message.id)
      clearTimeout(request.timer)
      if (message.error) request.reject(new Error(message.error.message))
      else request.resolve(message.result)
    })
    socket.addEventListener("close", () => { if (client.socket === socket) client.rejectPending() })
    socket.addEventListener("error", () => { if (client.socket === socket) client.rejectPending() })
  }

  static async connect(url: string, timeout = 10_000): Promise<Cdp> {
    const socket = new WebSocket(url)
    const client = new Cdp(socket)
    await Cdp.ready(socket, timeout)
    return client
  }

  private static async ready(socket: WebSocket, timeout = 10_000) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error("Chrome CDP connection timed out")) }, timeout)
      socket.addEventListener("open", () => { clearTimeout(timer); resolve() }, { once: true })
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Chrome CDP connection failed")) }, { once: true })
    })
  }

  static disconnected(client: Cdp) {
    return !!client.socket && client.socket.readyState !== WebSocket.OPEN
  }

  /** Reattach to the exact same Chrome endpoint, preserving live process/tab identity.
   * Static so compatible plugin reloads can also repair older live Cdp instances.
   * Never replay a command here: callers may retry only read-only metadata.
   */
  static async reconnect(client: Cdp) {
    if (!Cdp.disconnected(client)) return
    const previous = client.socket
    const socket = new WebSocket(previous.url)
    client.rejectPending()
    previous.close()
    client.socket = socket
    Cdp.listen(client, socket)
    await Cdp.ready(socket)
  }

  async send<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.socket.readyState !== WebSocket.OPEN) throw new Error("Chrome disconnected")
    const id = ++this.next
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Chrome ${method} timed out`))
      }, 10_000)
      this.pending.set(id, { resolve, reject, timer })
      try { this.socket.send(JSON.stringify({ id, method, params })) } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  private rejectPending() {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(new Error("Chrome disconnected"))
    }
    this.pending.clear()
  }

  close() { this.rejectPending(); this.socket.close() }
}

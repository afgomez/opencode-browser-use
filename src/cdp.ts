/** Minimal browser-level CDP connection. Page automation stays in upstream MCP. */
export class Cdp {
  private next = 0
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>()
  private constructor(private socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data))
      const request = this.pending.get(message.id)
      if (!request) return
      this.pending.delete(message.id)
      clearTimeout(request.timer)
      if (message.error) request.reject(new Error(message.error.message))
      else request.resolve(message.result)
    })
    socket.addEventListener("close", () => this.rejectPending())
    socket.addEventListener("error", () => this.rejectPending())
  }

  static async connect(url: string): Promise<Cdp> {
    const socket = new WebSocket(url)
    const client = new Cdp(socket)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error("Chrome CDP connection timed out")) }, 10_000)
      socket.addEventListener("open", () => { clearTimeout(timer); resolve() }, { once: true })
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Chrome CDP connection failed")) }, { once: true })
    })
    return client
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

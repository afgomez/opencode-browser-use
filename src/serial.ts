/** All calls, including lifecycle changes, share one queue. No selected-page races. */
export class Serial {
  private tail: Promise<unknown> = Promise.resolve()
  private pending = 0
  get queued() { return this.pending }

  constructor(private onIdle?: () => void) {}

  run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    this.pending++
    const result = this.tail.then(() => {
      signal?.throwIfAborted()
      return work()
    })
    this.tail = result.catch(() => {}).finally(() => {
      if (--this.pending === 0) this.onIdle?.()
    })
    return result
  }
}

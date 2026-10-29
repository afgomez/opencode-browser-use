/** All calls, including lifecycle changes, share one queue. No selected-page races. */
export class Serial {
  private tail: Promise<unknown> = Promise.resolve()

  run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const result = this.tail.then(() => {
      signal?.throwIfAborted()
      return work()
    })
    this.tail = result.catch(() => {})
    return result
  }
}

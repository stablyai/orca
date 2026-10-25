/** Opaque handle returned by `create`, so a release needs no string parsing to find its owner. */
export type ClientRequestAbortHandle = {
  readonly clientId: number
  readonly requestId: number
}

export class ClientRequestAborts {
  // Index by client so churn teardown visits only its requests rather than every client’s entries.
  // Coerce ids with String to preserve cancellation across wire "7" and rpc.cancel’s numeric 7.
  private readonly byClient = new Map<number, Map<string, AbortController>>()

  create(
    clientId: number,
    requestId: number
  ): { key: ClientRequestAbortHandle; controller: AbortController } {
    const controller = new AbortController()
    let requests = this.byClient.get(clientId)
    if (!requests) {
      requests = new Map<string, AbortController>()
      this.byClient.set(clientId, requests)
    }
    requests.set(String(requestId), controller)
    return { key: { clientId, requestId }, controller }
  }

  get(clientId: number, requestId: number): AbortController | undefined {
    return this.byClient.get(clientId)?.get(String(requestId))
  }

  delete(key: ClientRequestAbortHandle): void {
    const requests = this.byClient.get(key.clientId)
    if (!requests) {
      return
    }
    requests.delete(String(key.requestId))
    // Delete empty buckets so client churn cannot retain entries for the relay’s lifetime.
    if (requests.size === 0) {
      this.byClient.delete(key.clientId)
    }
  }

  abortClient(clientId: number): void {
    const requests = this.byClient.get(clientId)
    if (!requests) {
      return
    }
    // Unlink before aborting: an abort listener that reaches back in must not see a half-emptied
    // bucket, and the whole bucket is going regardless.
    this.byClient.delete(clientId)
    for (const controller of requests.values()) {
      controller.abort()
    }
  }

  abortAll(): void {
    const buckets = Array.from(this.byClient.values())
    this.byClient.clear()
    for (const requests of buckets) {
      for (const controller of requests.values()) {
        controller.abort()
      }
    }
  }
}

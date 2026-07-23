import { measureUtf8ByteLength } from '../../../shared/utf8-byte-limits'

export const WEB_PRELOAD_MAX_ABORTABLE_REQUESTS = 256
export const WEB_PRELOAD_MAX_REQUEST_TOKEN_BYTES = 4 * 1024

export class WebPreloadRequestOwners {
  private readonly controllers = new Map<string, AbortController>()

  replace(requestToken: string): AbortController {
    const measured = measureUtf8ByteLength(requestToken, {
      stopAfterBytes: WEB_PRELOAD_MAX_REQUEST_TOKEN_BYTES
    })
    if (requestToken.length === 0 || measured.exceededLimit) {
      throw new Error(
        `Web request token must be between 1 and ${WEB_PRELOAD_MAX_REQUEST_TOKEN_BYTES} UTF-8 bytes.`
      )
    }
    const existing = this.controllers.get(requestToken)
    if (!existing && this.controllers.size >= WEB_PRELOAD_MAX_ABORTABLE_REQUESTS) {
      throw new Error('Web request capacity reached; wait for an active request to finish.')
    }
    existing?.abort()
    const controller = new AbortController()
    this.controllers.set(requestToken, controller)
    return controller
  }

  abort(requestToken: string): void {
    this.controllers.get(requestToken)?.abort()
  }

  release(requestToken: string, expected: AbortController): void {
    if (this.controllers.get(requestToken) === expected) {
      this.controllers.delete(requestToken)
    }
  }

  abortAll(): void {
    const controllers = [...this.controllers.values()]
    this.controllers.clear()
    for (const controller of controllers) {
      controller.abort()
    }
  }

  size(): number {
    return this.controllers.size
  }
}

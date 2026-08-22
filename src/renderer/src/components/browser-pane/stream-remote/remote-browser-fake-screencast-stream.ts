export type FakeScreencastStream = {
  pageId: string
  params: unknown
  viewportWidth: number | undefined
  viewportHeight: number | undefined
  unsubscribeCount: number
  emitReady: () => void
  emitFrame: () => void
  emitEnd: () => void
  emitStreamError: (message: string) => void
  emitMalformedSuccess: () => void
  emitResponseFailure: (code: string, message: string) => void
  emitTransportError: (code: string, message: string) => void
  emitClose: () => void
}

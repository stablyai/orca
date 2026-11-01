// Do not use term_: renderer-epoch/leaves validation would discard a main-minted terminal leaf on reload.
export const STRUCTURED_WORKER_HANDLE_PREFIX = 'structworker_'

export function isStructuredWorkerHandle(
  handle: string | null | undefined
): handle is `${typeof STRUCTURED_WORKER_HANDLE_PREFIX}${string}` {
  return typeof handle === 'string' && handle.startsWith(STRUCTURED_WORKER_HANDLE_PREFIX)
}

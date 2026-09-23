// Deliberately not `term_`: `issueHandle` revalidates the renderer graph epoch against the
// renderer-driven leaves map, so a main-minted `term_` leaf evaporates on the next window reload.
export const STRUCTURED_WORKER_HANDLE_PREFIX = 'structworker_'

export function isStructuredWorkerHandle(handle: string | null | undefined): boolean {
  return typeof handle === 'string' && handle.startsWith(STRUCTURED_WORKER_HANDLE_PREFIX)
}

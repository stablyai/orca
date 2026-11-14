// Modal owners with pending work use this hook to settle when the singleton slot evicts them.
export const MODAL_DISMISSED_KEY = 'onModalDismissed'

export function settleEvictedModalData(evicted: Record<string, unknown>): void {
  const onDismissed = evicted[MODAL_DISMISSED_KEY]
  if (typeof onDismissed === 'function') {
    ;(onDismissed as () => void)()
  }
}

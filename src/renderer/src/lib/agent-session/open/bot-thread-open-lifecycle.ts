let pending: { key: string; controller: AbortController; result: Promise<void> } | undefined

/** A newer navigation in this window takes precedence over a pending external bot thread link. */
export function cancelPendingBotThreadOpen(): void {
  const previous = pending
  pending = undefined
  previous?.controller.abort()
}

export function runBotThreadOpen(
  key: string,
  open: (signal: AbortSignal) => Promise<void>
): Promise<void> {
  if (pending?.key === key) {
    return pending.result
  }
  cancelPendingBotThreadOpen()
  const controller = new AbortController()
  const result = open(controller.signal).finally(() => {
    if (pending?.controller === controller) {
      pending = undefined
    }
  })
  pending = { key, controller, result }
  return result
}

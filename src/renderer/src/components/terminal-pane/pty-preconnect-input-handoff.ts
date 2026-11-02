import type { PtyPreconnectInputEntry } from './pty-preconnect-input-buffer'

export const notifyRetainedPtyInput = (
  onRetained: ((entry: PtyPreconnectInputEntry) => void) | undefined,
  input: PtyPreconnectInputEntry
): void => {
  try {
    onRetained?.({
      data: input.data,
      kind: input.kind,
      inputKind: input.inputKind,
      ...(input.calls ? { calls: input.calls.slice() } : {})
    })
  } catch {
    // Handoff capture is advisory; a callback failure must not reject input admission.
  }
}

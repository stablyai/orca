import type { editor } from 'monaco-editor'
import { vi } from 'vitest'

/** Minimal ITextModel for Copilot document tests: text, a content-change listener set, and a uri. */
export function createFakeCopilotModel(initialText: string, uri = 'file:///repo/a.ts') {
  let text = initialText
  const listeners = new Set<() => void>()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test double implementing only the ITextModel members Copilot document sync reads.
  const model = {
    uri: { toString: () => uri },
    getValue: () => text,
    getValueLength: () => text.length,
    isDisposed: () => false,
    onDidChangeContent: (callback: () => void) => {
      listeners.add(callback)
      return { dispose: vi.fn(() => listeners.delete(callback)) }
    }
  } as unknown as editor.ITextModel
  return {
    model,
    listenerCount: () => listeners.size,
    edit(next: string): void {
      text = next
      for (const listener of listeners) {
        listener()
      }
    }
  }
}

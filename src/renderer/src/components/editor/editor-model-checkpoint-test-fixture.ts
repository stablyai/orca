import { vi } from 'vitest'
import type { CheckpointTextModel } from './editor-model-content-checkpoint'

export function createCheckpointModelFixture(initialContent = 'baseline') {
  let content = initialContent
  let version = 1
  const listeners = new Set<Parameters<CheckpointTextModel['onDidChangeContent']>[0]>()
  const disposeListeners = new Set<Parameters<CheckpointTextModel['onWillDispose']>[0]>()
  const model: CheckpointTextModel = {
    getValue: vi.fn(() => content),
    getVersionId: () => version,
    onDidChangeContent: (listener) => {
      listeners.add(listener)
      return { dispose: () => listeners.delete(listener) }
    },
    onWillDispose: (listener) => {
      disposeListeners.add(listener)
      return { dispose: () => disposeListeners.delete(listener) }
    }
  }
  return {
    model,
    edit: (nextContent: string) => {
      content = nextContent
      version++
      listeners.forEach((listener) =>
        listener({
          changes: [],
          detailedReasonsChangeLengths: [],
          eol: '\n',
          versionId: version,
          isEolChange: false,
          isFlush: false,
          isUndoing: false,
          isRedoing: false
        })
      )
    },
    dispose: () => disposeListeners.forEach((listener) => listener()),
    listenerCount: () => listeners.size
  }
}

import type { editor } from 'monaco-editor'
import { createDeadlineDebouncer } from '@/lib/deadline-debouncer'
import { notifyPendingEditorChange, registerPendingEditorFlush } from './editor-pending-flush'

export type CheckpointTextModel = Pick<
  editor.ITextModel,
  'getValue' | 'getVersionId' | 'onDidChangeContent' | 'onWillDispose'
>
export type EditorModelCheckpointBinding = {
  fileId?: string
  publish: (content: string) => void
  onPending?: () => void
  shouldIgnore?: () => boolean
}
type ModelCheckpoint = {
  bindings: Set<EditorModelCheckpointBinding>
  pending: Set<EditorModelCheckpointBinding>
  snapshot?: { content: string; version: number }
  flush: () => void
  dispose: () => void
}
const checkpoints = new WeakMap<CheckpointTextModel, ModelCheckpoint>()
const programmaticModels = new WeakSet<CheckpointTextModel>()
let publicationDepth = 0

export function isPublishingEditorModelContent(): boolean {
  return publicationDepth > 0
}

function createModelCheckpoint(model: CheckpointTextModel): ModelCheckpoint {
  const bindings = new Set<EditorModelCheckpointBinding>()
  const pending = new Set<EditorModelCheckpointBinding>()
  const source: ModelCheckpoint = {
    bindings,
    pending,
    flush: () => {
      debouncer.cancel()
      if (pending.size === 0) {
        return
      }
      const version = model.getVersionId()
      const content = model.getValue()
      source.snapshot = { content, version }
      const changed = [...pending]
      // Why: a publication can synchronously trigger another edit; that edit owes a later flush.
      pending.clear()
      publicationDepth++
      try {
        for (const binding of changed) {
          if (bindings.has(binding)) {
            binding.publish(content)
          }
        }
      } finally {
        publicationDepth--
      }
    },
    dispose: () => {
      debouncer.cancel()
      contentSubscription.dispose()
      disposeSubscription.dispose()
      checkpoints.delete(model)
    }
  }
  const debouncer = createDeadlineDebouncer(source.flush, 150, 500)
  const contentSubscription = model.onDidChangeContent(() => {
    if (programmaticModels.has(model)) {
      return
    }
    for (const binding of bindings) {
      if (binding.shouldIgnore?.()) {
        continue
      }
      const wasPending = pending.has(binding)
      pending.add(binding)
      if (!wasPending) {
        binding.onPending?.()
      }
      if (binding.fileId) {
        notifyPendingEditorChange(binding.fileId)
      }
    }
    if (pending.size > 0) {
      debouncer.schedule()
    }
  })
  const disposeSubscription = model.onWillDispose(() => {
    source.flush()
    source.dispose()
  })
  return source
}

/** Split panes share one subscription, one deadline, and one full-text read per checkpoint. */
export function registerEditorModelContentCheckpoint(
  model: CheckpointTextModel,
  binding: EditorModelCheckpointBinding
): () => void {
  const source = checkpoints.get(model) ?? createModelCheckpoint(model)
  checkpoints.set(model, source)
  source.bindings.add(binding)
  const unregister = binding.fileId
    ? registerPendingEditorFlush(binding.fileId, source.flush, () => source.pending.has(binding))
    : undefined
  return () => {
    source.flush()
    unregister?.()
    source.bindings.delete(binding)
    source.pending.delete(binding)
    if (source.bindings.size === 0) {
      source.dispose()
    }
  }
}

export function flushEditorModelContentCheckpoint(model: CheckpointTextModel): void {
  checkpoints.get(model)?.flush()
}

export function hasPendingEditorModelContent(model: CheckpointTextModel): boolean {
  return (checkpoints.get(model)?.pending.size ?? 0) > 0
}

/** A delayed React echo must never replace edits made after that published snapshot. */
export function isStaleEditorModelContent(model: CheckpointTextModel, content: string): boolean {
  const source = checkpoints.get(model)
  return (
    source?.snapshot?.content === content &&
    source.snapshot.version !== model.getVersionId() &&
    source.pending.size > 0
  )
}

export function isCurrentEditorModelContent(model: CheckpointTextModel, content: string): boolean {
  const snapshot = checkpoints.get(model)?.snapshot
  return snapshot?.content === content && snapshot.version === model.getVersionId()
}

export function withEditorModelContentSync(model: CheckpointTextModel, sync: () => void): void {
  const alreadySyncing = programmaticModels.has(model)
  programmaticModels.add(model)
  try {
    sync()
  } finally {
    if (!alreadySyncing) {
      programmaticModels.delete(model)
    }
  }
}

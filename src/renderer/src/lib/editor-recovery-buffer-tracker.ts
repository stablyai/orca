import type { AppState } from '@/store/types'
import {
  editorRecoveryResourceKey,
  type EditorRecoveryChange,
  type EditorRecoveryMetadata
} from '../../../shared/editor-recovery'
import { shouldPersistWorkspaceSession } from './workspace-session'
import { canRecoverEditorBuffer, captureEditorRecoveryMetadata } from './editor-recovery-metadata'
import {
  clearEditorRecoveryCheckpoint,
  setEditorRecoveryCheckpoint
} from './editor-recovery-checkpoints'
import { buildHostIdByWorktreeId } from './workspace-session-host-persistence'
import { createBrowserUuid } from './browser-uuid'
import type { ExternalRecoveryBuffer } from './editor-recovery-external-buffers'

export type EditorRecoveryBuffer = {
  id: string
  fileId: string
  revision: number
  metadata: EditorRecoveryMetadata
  content: string
  durableContent?: string
  state: 'active' | 'retained' | 'resolved'
  version: number
}

export class EditorRecoveryBufferTracker {
  readonly buffers = new Map<string, EditorRecoveryBuffer>()
  readonly pending = new Set<string>()
  private readonly byFileId = new Map<string, EditorRecoveryBuffer>()
  private readonly recentlyClean = new Map<string, EditorRecoveryBuffer>()
  private readonly adoptedIds = new Set<string>()

  capture(state: AppState, external: readonly ExternalRecoveryBuffer[] = []): void {
    if (!shouldPersistWorkspaceSession(state)) {
      return
    }
    const present = new Set<string>()
    const externalById = new Map(external.map((buffer) => [buffer.file.id, buffer]))
    let hostForWorktree: ReturnType<typeof buildHostIdByWorktreeId> | undefined
    for (const file of [...state.openFiles, ...external.map((buffer) => buffer.file)]) {
      if (!canRecoverEditorBuffer(file)) {
        continue
      }
      present.add(file.id)
      const content = externalById.get(file.id)?.content ?? state.editorDrafts[file.id]
      let buffer = this.byFileId.get(file.id)
      if (!file.isDirty) {
        if (buffer) {
          if (buffer.state === 'resolved') {
            this.byFileId.delete(file.id)
          } else {
            this.retain(buffer)
          }
        }
        continue
      }
      if (content === undefined) {
        continue
      }
      const metadata =
        buffer &&
        buffer.metadata.filePath === file.filePath &&
        buffer.metadata.worktreeId === file.worktreeId &&
        buffer.metadata.runtimeEnvironmentId === file.runtimeEnvironmentId &&
        buffer.metadata.externalSshTargetId === file.externalSshTargetId &&
        buffer.metadata.relativePath === file.relativePath &&
        buffer.metadata.language === file.language &&
        (!file.operationProvenance?.generation.route.executionHostId ||
          file.externalSshTargetId ||
          buffer.metadata.hostId === file.operationProvenance.generation.route.executionHostId) &&
        buffer.metadata.bufferKind ===
          (file.mode === 'diff' || file.recoveryBufferKind === 'diff' ? 'diff' : 'edit') &&
        buffer.metadata.lastKnownDiskSignature === file.lastKnownDiskSignature
          ? buffer.metadata
          : captureEditorRecoveryMetadata(
              file,
              state,
              (hostForWorktree ??= buildHostIdByWorktreeId(state))
            )
      if (buffer?.state === 'resolved') {
        // Store listeners may still present the dirty snapshot while discard finishes.
        if (
          buffer.content === content &&
          editorRecoveryResourceKey(buffer.metadata) === editorRecoveryResourceKey(metadata)
        ) {
          continue
        }
        this.byFileId.delete(file.id)
        buffer = undefined
      }
      if (
        buffer &&
        buffer.metadata !== metadata &&
        editorRecoveryResourceKey(buffer.metadata) !== editorRecoveryResourceKey(metadata)
      ) {
        this.retain(buffer)
        buffer = undefined
      }
      if (!buffer) {
        const restoredId = file.recoveryId
        const adopt = restoredId !== undefined && !this.adoptedIds.has(restoredId)
        const revision = adopt ? (file.recoveryRevision ?? 0) : 0
        buffer = {
          id: adopt ? restoredId : createBrowserUuid(),
          fileId: file.id,
          revision,
          metadata,
          content,
          durableContent: revision > 0 ? content : undefined,
          state: 'active',
          version: 0
        }
        if (adopt) {
          this.adoptedIds.add(restoredId)
        }
        this.buffers.set(buffer.id, buffer)
        this.byFileId.set(file.id, buffer)
        this.recentlyClean.delete(file.id)
        if (revision === 0) {
          this.markPending(buffer)
        }
      } else if (buffer.content !== content || buffer.metadata !== metadata) {
        buffer.content = content
        buffer.metadata = metadata
        this.markPending(buffer)
      }
      this.publishCheckpoint(buffer)
    }
    for (const [fileId, buffer] of this.byFileId) {
      if (!present.has(fileId)) {
        if (buffer.state === 'resolved') {
          this.byFileId.delete(fileId)
        } else {
          this.retain(buffer)
        }
      }
    }
  }

  resolve(fileId: string, savedContent?: string): EditorRecoveryBuffer | undefined {
    const buffer = this.byFileId.get(fileId) ?? this.recentlyClean.get(fileId)
    if (!buffer || (savedContent !== undefined && buffer.content !== savedContent)) {
      return
    }
    buffer.state = 'resolved'
    this.markPending(buffer)
    this.recentlyClean.delete(fileId)
    clearEditorRecoveryCheckpoint(fileId, buffer.id)
    return buffer
  }

  rejectResolution(buffer: EditorRecoveryBuffer): void {
    buffer.state = this.byFileId.get(buffer.fileId) === buffer ? 'active' : 'retained'
    this.buffers.set(buffer.id, buffer)
    this.markPending(buffer)
    if (buffer.state === 'active') {
      this.publishCheckpoint(buffer)
    }
  }

  acknowledge(
    buffer: EditorRecoveryBuffer,
    version: number,
    change: EditorRecoveryChange,
    content: string,
    revision: number | null,
    publish: boolean
  ): void {
    if (revision === null) {
      this.forget(buffer)
      if (buffer.state !== 'resolved') {
        buffer.id = createBrowserUuid()
        buffer.revision = 0
        buffer.durableContent = undefined
        this.buffers.set(buffer.id, buffer)
        this.markPending(buffer)
      }
    } else {
      buffer.revision = revision
      if (change.kind === 'put' || change.kind === 'patch') {
        buffer.durableContent = content
      }
      if (buffer.version === version && buffer.state !== 'active') {
        this.forget(buffer)
      }
    }
    if (publish && buffer.state === 'active' && this.byFileId.get(buffer.fileId) === buffer) {
      this.publishCheckpoint(buffer)
    }
  }

  forget(buffer: EditorRecoveryBuffer): void {
    this.buffers.delete(buffer.id)
    this.pending.delete(buffer.id)
    if (this.recentlyClean.get(buffer.fileId) === buffer) {
      this.recentlyClean.delete(buffer.fileId)
    }
  }

  dispose(): void {
    for (const buffer of this.byFileId.values()) {
      clearEditorRecoveryCheckpoint(buffer.fileId, buffer.id)
    }
  }

  private markPending(buffer: EditorRecoveryBuffer): void {
    buffer.version++
    this.pending.add(buffer.id)
  }
  private retain(buffer: EditorRecoveryBuffer): void {
    buffer.state = 'retained'
    this.markPending(buffer)
    this.recentlyClean.set(buffer.fileId, buffer)
    this.byFileId.delete(buffer.fileId)
    clearEditorRecoveryCheckpoint(buffer.fileId, buffer.id)
  }
  private publishCheckpoint(buffer: EditorRecoveryBuffer): void {
    setEditorRecoveryCheckpoint(buffer.fileId, {
      id: buffer.id,
      revision: buffer.revision,
      bufferKind: buffer.metadata.bufferKind
    })
  }
}

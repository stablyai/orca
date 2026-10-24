// Why: shared rig for guarded-save suites — a fake host that compares the precondition inside the
// write like the real writer, and a dirty tab with a known disk baseline.
import { vi } from 'vitest'
import type { StoreApi } from 'zustand'
import type { AppState } from '@/store'
import { getDiskBaselineSignature } from '../../../../shared/disk-baseline-signature'
import {
  compareDiskWritePrecondition,
  type FileWriteDiskPrecondition
} from '../../../../shared/file-write-disk-precondition'

export const GUARDED_PATH = '/repo/file.ts'

export type GuardedWriteArgs = {
  filePath: string
  content: string
  diskPrecondition?: FileWriteDiskPrecondition
}

/** `beforeWrite` lets a test hold a write in flight. */
export function stubGuardedDisk(
  initial: Record<string, string>,
  beforeWrite: () => Promise<void> = () => Promise.resolve()
) {
  const files = new Map(Object.entries(initial))
  const writeFile = vi.fn(async ({ filePath, content, diskPrecondition }: GuardedWriteArgs) => {
    await beforeWrite()
    if (diskPrecondition) {
      const diskConflict = compareDiskWritePrecondition(
        diskPrecondition,
        files.get(filePath) ?? null,
        content
      )
      if (diskConflict === 'identical') {
        return { ok: true, unchanged: true }
      }
      if (diskConflict) {
        return { ok: false, diskConflict }
      }
    }
    files.set(filePath, content)
    return { ok: true }
  })
  const eventTarget = new EventTarget()
  vi.stubGlobal('window', {
    addEventListener: eventTarget.addEventListener.bind(eventTarget),
    removeEventListener: eventTarget.removeEventListener.bind(eventTarget),
    dispatchEvent: eventTarget.dispatchEvent.bind(eventTarget),
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    api: { fs: { writeFile } }
  })
  return { files, writeFile }
}

export function openGuardedFile(
  store: StoreApi<AppState>,
  options: { baseline?: string; draft: string; filePath?: string; language?: string }
): string {
  const filePath = options.filePath ?? GUARDED_PATH
  store.getState().openFile({
    filePath,
    relativePath: filePath.slice('/repo/'.length),
    worktreeId: 'wt-1',
    language: options.language ?? 'typescript',
    mode: 'edit'
  })
  if (options.baseline !== undefined) {
    store.getState().setLastKnownDiskSignature(filePath, getDiskBaselineSignature(options.baseline))
  }
  store.getState().setEditorDraft(filePath, options.draft)
  store.getState().markFileDirty(filePath, true)
  return filePath
}

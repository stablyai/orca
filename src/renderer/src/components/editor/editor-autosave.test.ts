import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import {
  canAutoSaveOpenFile,
  getOpenFilesForExternalFileChange,
  normalizeAutoSaveDelayMs,
  ORCA_EDITOR_QUIESCE_FILE_SAVES_EVENT,
  requestEditorSaveQuiesce
} from './editor-autosave'

type WindowEventStub = Pick<
  Window,
  'addEventListener' | 'removeEventListener' | 'dispatchEvent' | 'setTimeout' | 'clearTimeout'
>

function makeOpenFile(overrides: Partial<OpenFile> = {}): OpenFile {
  return {
    id: '/repo/file.ts',
    filePath: '/repo/file.ts',
    relativePath: 'file.ts',
    worktreeId: 'wt-1',
    language: 'typescript',
    isDirty: false,
    mode: 'edit',
    ...overrides
  }
}

beforeEach(() => {
  const eventTarget = new EventTarget()
  vi.stubGlobal('window', {
    addEventListener: eventTarget.addEventListener.bind(eventTarget),
    removeEventListener: eventTarget.removeEventListener.bind(eventTarget),
    dispatchEvent: eventTarget.dispatchEvent.bind(eventTarget),
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis)
  } satisfies WindowEventStub)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('canAutoSaveOpenFile', () => {
  it('allows normal edit tabs and unstaged single-file diffs', () => {
    expect(canAutoSaveOpenFile(makeOpenFile())).toBe(true)
    expect(
      canAutoSaveOpenFile(
        makeOpenFile({
          id: 'wt-1::diff::unstaged::file.ts',
          mode: 'diff',
          diffSource: 'unstaged'
        })
      )
    ).toBe(true)
  })

  it('rejects staged, combined, and conflict-review tabs', () => {
    expect(
      canAutoSaveOpenFile(
        makeOpenFile({
          id: 'wt-1::diff::staged::file.ts',
          mode: 'diff',
          diffSource: 'staged'
        })
      )
    ).toBe(false)
    expect(
      canAutoSaveOpenFile(
        makeOpenFile({
          id: 'wt-1::all-diffs::uncommitted',
          filePath: '/repo',
          relativePath: 'All Changes',
          mode: 'diff',
          diffSource: 'combined-uncommitted'
        })
      )
    ).toBe(false)
    expect(
      canAutoSaveOpenFile(
        makeOpenFile({
          id: 'wt-1::conflicts',
          filePath: '/repo',
          relativePath: 'Conflicts',
          mode: 'conflict-review'
        })
      )
    ).toBe(false)
  })
})

describe('normalizeAutoSaveDelayMs', () => {
  it('defaults and clamps invalid values', () => {
    expect(normalizeAutoSaveDelayMs(undefined)).toBe(1000)
    expect(normalizeAutoSaveDelayMs(Number.NaN)).toBe(1000)
    expect(normalizeAutoSaveDelayMs('750')).toBe(750)
    expect(normalizeAutoSaveDelayMs('oops')).toBe(1000)
    expect(normalizeAutoSaveDelayMs(10)).toBe(250)
    expect(normalizeAutoSaveDelayMs(25_000)).toBe(10_000)
  })
})

describe('requestEditorSaveQuiesce', () => {
  it('resolves immediately when no editor listener claims the request', async () => {
    await expect(requestEditorSaveQuiesce({ fileId: 'file-1' })).resolves.toBeUndefined()
  })

  it('waits for a claiming listener to finish quiescing', async () => {
    let resolved = false
    const handler = (event: Event): void => {
      const detail = (event as CustomEvent).detail as {
        claim: () => void
        resolve: () => void
      }
      detail.claim()
      window.setTimeout(() => detail.resolve(), 0)
    }

    window.addEventListener(ORCA_EDITOR_QUIESCE_FILE_SAVES_EVENT, handler as EventListener)
    try {
      const promise = requestEditorSaveQuiesce({ fileId: 'file-1' }).then(() => {
        resolved = true
      })

      expect(resolved).toBe(false)
      await promise
      expect(resolved).toBe(true)
    } finally {
      window.removeEventListener(ORCA_EDITOR_QUIESCE_FILE_SAVES_EVENT, handler as EventListener)
    }
  })
})

describe('getOpenFilesForExternalFileChange', () => {
  it('matches edit tabs and unstaged diff tabs for the same worktree file', () => {
    const matchingEdit = makeOpenFile()
    const matchingUnstagedDiff = makeOpenFile({
      id: 'wt-1::diff::unstaged::file.ts',
      mode: 'diff',
      diffSource: 'unstaged'
    })
    const stagedDiff = makeOpenFile({
      id: 'wt-1::diff::staged::file.ts',
      mode: 'diff',
      diffSource: 'staged'
    })
    const otherWorktree = makeOpenFile({
      id: '/other/file.ts',
      filePath: '/other/file.ts',
      worktreeId: 'wt-2'
    })

    expect(
      getOpenFilesForExternalFileChange(
        [matchingEdit, matchingUnstagedDiff, stagedDiff, otherWorktree],
        {
          worktreeId: 'wt-1',
          worktreePath: '/repo',
          relativePath: 'file.ts'
        }
      ).map((file) => file.id)
    ).toEqual(['/repo/file.ts', 'wt-1::diff::unstaged::file.ts'])
  })
})

import { beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { makeWorktree } from '../../worktrees-slice-test-fixtures'
import type { OpenFile } from '../types/open-file'
import { isDetachedEditorBufferId } from './editor-buffer-views'
import { conflictOverviewView, conflictOverviewViewsKey } from './editor-buffer-conflict-overview'

const PATH = '/repo/a.ts'

function tab(id: string, worktreeId: string, patch: Partial<OpenFile> = {}): OpenFile {
  return {
    id,
    filePath: PATH,
    relativePath: 'a.ts',
    worktreeId,
    language: 'typescript',
    isDirty: false,
    mode: 'edit',
    lastKnownDiskSignature: 'sig-base',
    ...patch
  }
}

const state = () => useAppStore.getState()

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    worktreesByRepo: {
      'repo-1': [
        makeWorktree({ id: 'wt-1', repoId: 'repo-1', path: '/repo', hostId: 'local' }),
        makeWorktree({ id: 'wt-2', repoId: 'repo-1', path: '/repo', hostId: 'local' })
      ]
    }
  })
})

describe('conflictOverviewView', () => {
  it("borrows another workspace's view when this one has none, else shows disk text", () => {
    useAppStore.setState({ openFiles: [tab('a', 'wt-1')] })
    expect(conflictOverviewView(state(), 'wt-2', PATH)?.id).toBe('a')
    useAppStore.setState({ openFiles: [] })
    expect(conflictOverviewView(state(), 'wt-2', PATH)).toBeNull()
  })

  it("prefers this workspace's detached tab, with its own edits, over another workspace's view", () => {
    useAppStore.setState({
      openFiles: [tab('a', 'wt-1', { isDirty: true }), tab('b', 'wt-2', { isDirty: true })],
      editorDrafts: { a: 'abc', b: 'abcd' }
    })
    expect(isDetachedEditorBufferId(state().editorBufferIdOf.b)).toBe(true)
    expect(conflictOverviewView(state(), 'wt-2', PATH)?.id).toBe('b')
    expect(conflictOverviewView(state(), 'wt-1', PATH)?.id).toBe('a')
  })

  it('re-resolves when the tabs change, and the views key follows', () => {
    useAppStore.setState({ openFiles: [tab('a', 'wt-1')] })
    const before = conflictOverviewViewsKey(state(), 'wt-2', [PATH])
    expect(conflictOverviewViewsKey(state(), 'wt-2', [PATH])).toBe(before)
    useAppStore.setState({ openFiles: [tab('a', 'wt-1'), tab('c', 'wt-2')] })
    expect(conflictOverviewView(state(), 'wt-2', PATH)?.id).toBe('c')
    expect(conflictOverviewViewsKey(state(), 'wt-2', [PATH])).not.toBe(before)
  })

  it('keeps answering correctly past the stand-in cache bound', () => {
    useAppStore.setState({ openFiles: [tab('a', 'wt-1')] })
    for (let index = 0; index < 300; index += 1) {
      conflictOverviewView(state(), 'wt-1', `/repo/other-${index}.ts`)
    }
    useAppStore.setState({ openFiles: [tab('a', 'wt-1')] })
    expect(conflictOverviewView(state(), 'wt-2', PATH)?.id).toBe('a')
  })
})

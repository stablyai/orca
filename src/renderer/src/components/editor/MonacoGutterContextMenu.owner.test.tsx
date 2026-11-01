// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { StoreApi } from 'zustand'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import type { OpenFile } from '@/store/slices/editor'
import { createEditorTabsStore } from '@/store/slices/editor-slice-test-harness'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { getRuntimeGitRemoteFileUrl } from '@/runtime/runtime-git-working-tree-client'
import { MonacoGutterContextMenu } from './MonacoGutterContextMenu'

const storeRef = vi.hoisted((): { current?: StoreApi<AppState> } => ({}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => storeRef.current?.getState() } }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('@/runtime/runtime-git-working-tree-client', () => ({
  getRuntimeGitRemoteFileUrl: vi.fn()
}))

function file(id: string, worktreeId: string, runtimeEnvironmentId: string): OpenFile {
  return {
    id,
    worktreeId,
    runtimeEnvironmentId,
    filePath: '/repo/file.ts',
    relativePath: 'file.ts',
    language: 'typescript',
    mode: 'edit',
    isDirty: false
  }
}

function openMenu(fileId: string): void {
  render(
    <MonacoGutterContextMenu
      open
      onOpenChange={vi.fn()}
      point={{ x: 20, y: 20 }}
      line={7}
      selection={null}
      fileId={fileId}
      filePath="/repo/file.ts"
      relativePath="file.ts"
    />
  )
}

beforeEach(() => {
  const store = createEditorTabsStore()
  storeRef.current = store
  store.setState({
    openFiles: [
      file('host-a-file', 'host-a-worktree', 'host-a'),
      file('host-b-file', 'host-b-worktree', 'host-b')
    ],
    worktreesByRepo: {
      'repo-1': [
        makeWorktree({ id: 'host-a-worktree', repoId: 'repo-1', path: '/repo-a' }),
        makeWorktree({ id: 'host-b-worktree', repoId: 'repo-1', path: '/repo-b' })
      ]
    }
  })
  vi.stubGlobal('api', { ui: { writeClipboardText: vi.fn() } })
  vi.mocked(getRuntimeGitRemoteFileUrl).mockResolvedValue(
    'https://example.invalid/host-b/file.ts#L7'
  )
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

it('copies the mounted file owner URL when another host has the same absolute path', async () => {
  openMenu('host-b-file')
  fireEvent.click(screen.getByRole('menuitem', { name: 'Copy Remote URL' }))
  await vi.waitFor(() => expect(window.api.ui.writeClipboardText).toHaveBeenCalled())
  expect(getRuntimeGitRemoteFileUrl).toHaveBeenCalledWith(
    {
      target: { kind: 'environment', environmentId: 'host-b' },
      worktreeId: 'host-b-worktree',
      worktreePath: '/repo-b',
      connectionId: undefined
    },
    { relativePath: 'file.ts', line: 7 }
  )
  expect(window.api.ui.writeClipboardText).toHaveBeenCalledWith(
    'https://example.invalid/host-b/file.ts#L7'
  )
})

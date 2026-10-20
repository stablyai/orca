// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ read: vi.fn() }))

vi.mock('@/runtime/runtime-file-read-client', () => ({ readRuntimeFileContent: mocks.read }))
vi.mock('@/lib/connection-context', () => ({
  getConnectionIdForFile: (worktreeId: string) => (worktreeId === 'ssh-wt' ? 'ssh-target' : null)
}))
vi.mock('@/lib/file-owner-runtime-target', () => ({
  getRuntimeTargetForFileOwner: () => ({ kind: 'local' })
}))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ openFiles: [], editorDrafts: {} }) }
}))
vi.mock('./DiffViewer', () => ({ default: () => null }))

import { RecoveredEditorDraftCompareDialog } from './RecoveredEditorDraftCompareDialog'

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
  mocks.read.mockResolvedValue({ content: 'disk', isBinary: false })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

it('reads an SSH file through its connection, as the editor load does', async () => {
  const draft = { filePath: '/repo/a.ts', worktreeId: 'ssh-wt', draft: 'old', recoveredAt: 1 }

  await act(async () =>
    root.render(<RecoveredEditorDraftCompareDialog draft={draft} onOpenChange={() => {}} />)
  )

  expect(mocks.read).toHaveBeenCalledWith(expect.objectContaining({ connectionId: 'ssh-target' }))
})

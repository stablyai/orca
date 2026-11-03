import { afterEach, expect, it, vi } from 'vitest'

const requestEditorFileClose = vi.hoisted(() => vi.fn<(fileId: string) => void>())
vi.mock('../editor/editor-autosave', () => ({ requestEditorFileClose }))

import { useAppStore } from '../../store'
import { makeOpenFile, makeUnifiedTab } from '../../store/slices/store-session-test-harness'
import { registerEditorFrameFlush } from '../editor/editor-pending-flush'
import { createWorkspaceTabCloseCommands } from './workspace-tab-close-commands'

const worktreeId = 'wt'
const tabOf = (entityId: string) =>
  makeUnifiedTab({ id: 'tab', worktreeId, groupId: 'g', entityId, contentType: 'editor' })
const drainMicrotasks = () => new Promise((resolve) => setImmediate(resolve))

let removeFrame = () => {}
afterEach(() => removeFrame())

// Why: a rename keeps the tab id but moves its entity while the frame is flushing.
it('closes the renamed file, prompting when it is dirty, after the frame flush', async () => {
  let answer: (flushed: boolean) => void = () => {}
  removeFrame = registerEditorFrameFlush('old', () => new Promise((resolve) => (answer = resolve)))
  useAppStore.setState({
    openFiles: [makeOpenFile({ id: 'old', worktreeId })],
    unifiedTabsByWorktree: { [worktreeId]: [tabOf('old')] }
  })
  createWorkspaceTabCloseCommands({ worktreeId, groupTabs: [tabOf('old')] }).closeItem('tab')

  useAppStore.setState({
    openFiles: [makeOpenFile({ id: 'new', worktreeId, isDirty: true })],
    unifiedTabsByWorktree: { [worktreeId]: [tabOf('new')] }
  })
  answer(true)
  await drainMicrotasks()

  expect(requestEditorFileClose).toHaveBeenCalledWith('new', undefined)
  expect(useAppStore.getState().unifiedTabsByWorktree[worktreeId]).toHaveLength(1)
})

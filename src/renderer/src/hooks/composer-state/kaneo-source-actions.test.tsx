// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useIssueSourceActions } from './issue-source-actions'
import type { KaneoTask } from '../../../../shared/kaneo-types'

vi.mock('@/components/sidebar/folder-workspace-composer-helpers', () => ({
  toLinearLinkedWorkItem: vi.fn(),
  getLinkedItemDisplayName: vi.fn(),
  getSmartNameSelection: vi.fn()
}))
vi.mock('@/lib/new-workspace', async () => {
  const names = await import('../../../../shared/workspace-name')
  return {
    getLinkedWorkItemWorkspaceName: names.getLinkedWorkItemWorkspaceName,
    getLinkedWorkItemSuggestedName: names.getLinkedWorkItemSuggestedName
  }
})
afterEach(cleanup)

const task: KaneoTask = {
  siteUrl: 'https://tasks.example.com',
  workspaceId: 'ws',
  projectId: 'proj',
  taskId: 'task',
  url: 'https://tasks.example.com/dashboard/workspace/ws/project/proj/task/task',
  title: 'Fix booking',
  description: 'Investigate reservations',
  number: 42,
  status: 'todo'
}

describe('selecting a Kaneo workspace source', () => {
  it.each([false, true])('keeps link and launch context for folder=%s', (folder) => {
    const setters = Object.fromEntries(
      [
        'setBaseBranch',
        'setCompareBaseRef',
        'setPushTarget',
        'setLinkedIssue',
        'setLinkedPR',
        'setLinkedGitLabIssue',
        'setLinkedGitLabMR',
        'setLinkedTaskSourceContext',
        'setLinkedWorkItem',
        'setBranchNameOverride',
        'setBranchNameOverridePreservesNameEdits',
        'setForkPushWarning',
        'setName',
        'setNote'
      ].map((name) => [name, vi.fn()])
    )
    const input = {
      ...setters,
      isProjectGroupTarget: folder,
      name: task.url,
      linkedWorkItem: null,
      lastAutoNameRef: { current: '' },
      branchAutoNameRef: { current: 'old-branch' },
      lastAutoNoteRef: { current: '' },
      noteRef: { current: 'User instructions' },
      smartGitHubPrStartPointSelectionRef: { current: null }
    }
    const { result, rerender } = renderHook(
      ({ name }) => useIssueSourceActions({ ...input, name } as never),
      { initialProps: { name: task.url } }
    )
    act(() => result.current.handleSmartKaneoTaskSelect(task))
    expect(setters.setLinkedWorkItem).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'kaneo',
        url: task.url,
        title: task.title,
        linkedContext: expect.objectContaining({
          provider: 'kaneo',
          renderedText: expect.stringContaining(task.description)
        })
      })
    )
    expect(setters.setName).toHaveBeenCalledWith('fix-booking')
    expect(setters.setBranchNameOverride).toHaveBeenCalledWith(undefined)
    expect(setters.setNote).not.toHaveBeenCalled()
    setters.setName.mockClear()
    rerender({ name: 'My deliberate workspace name' })
    act(() => result.current.handleSmartKaneoTaskSelect(task))
    expect(setters.setName).not.toHaveBeenCalled()
  })
})

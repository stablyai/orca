// @vitest-environment happy-dom

import React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinkedWorkItemSummary } from '@/lib/new-workspace'
import type { AppState } from '@/store/types'
import type { KanbanRepoCandidate } from '@/components/task-page-kanban-repo-project-match'
import type { KanbanTaskDetails, KanbanTaskSummary } from '../../../../../shared/kanban-types'
import type * as KanbanWorkspaceLinkModule from '@/components/task-page-kanban-workspace-link'
import type * as WorktreeActivationModule from '@/lib/worktree-activation'
import { useTaskPageKanbanActions } from './use-task-page-kanban-actions'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const kanbanApi = vi.hoisted(() => ({
  getTask: vi.fn()
}))

const openModalMock = vi.hoisted(() => vi.fn())
const activateWorkspaceMock = vi.hoisted(() => vi.fn())
const findLinkMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/worktree-activation', async (importOriginal) => {
  const actual = await importOriginal<typeof WorktreeActivationModule>()
  return { ...actual, activateAndRevealWorkspace: activateWorkspaceMock }
})

vi.mock('@/components/task-page-kanban-workspace-link', async (importOriginal) => {
  const actual = await importOriginal<typeof KanbanWorkspaceLinkModule>()
  return { ...actual, findKanbanTaskWorkspaceLink: findLinkMock }
})

const summaryFixture: KanbanTaskSummary = {
  id: 't1',
  title: 'Task one',
  laneId: 'lane-open',
  laneName: 'Открыто',
  due: '2026-08-28',
  urgent: false,
  repositoryUrls: ['https://github.com/acme/widgets'],
  taskVersion: 1,
  executors: [{ id: 'u1', name: 'User One' }],
  observers: [],
  createdBy: null,
  url: 'https://kanban.fpimi.ru/?task=t1'
}

const detailsFixture: KanbanTaskDetails = {
  ...summaryFixture,
  result: 'Expected result text',
  description: 'Expected description text',
  tags: [],
  source: null,
  comments: [],
  blockedBy: [],
  attachments: [],
  subtasks: []
}

const widgetsRepo: KanbanRepoCandidate = {
  id: 'repo-widgets',
  gitRemoteIdentity: { remoteUrl: 'https://github.com/acme/widgets.git' }
}

function Harness({ repos }: { repos: readonly KanbanRepoCandidate[] }): React.JSX.Element {
  const { handleUseKanbanTask } = useTaskPageKanbanActions({
    repos,
    openModal: openModalMock as unknown as AppState['openModal']
  })
  return (
    <button type="button" onClick={() => handleUseKanbanTask(summaryFixture)}>
      start
    </button>
  )
}

let container: HTMLDivElement | null = null
let root: Root | null = null

function renderActions(repos: readonly KanbanRepoCandidate[]): HTMLDivElement {
  const host = document.createElement('div')
  document.body.appendChild(host)
  container = host
  root = createRoot(host)
  void act(() => {
    root?.render(<Harness repos={repos} />)
  })
  return host
}

function clickStart(host: HTMLDivElement): void {
  const button = host.querySelector('button')
  void act(() => {
    button?.click()
  })
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  kanbanApi.getTask.mockReset().mockResolvedValue(detailsFixture)
  openModalMock.mockReset()
  activateWorkspaceMock.mockReset().mockReturnValue({ primaryTabId: 'tab-1' })
  findLinkMock.mockReset().mockReturnValue(null)
  globalThis.window.api = {
    kanban: {
      status: vi.fn().mockResolvedValue({
        connected: true,
        viewer: { id: 'u1', name: 'User One', level: 'admin' }
      }),
      connect: vi.fn(),
      disconnect: vi.fn(),
      listTasks: vi.fn(),
      getTask: kanbanApi.getTask
    }
  } as never
})

afterEach(() => {
  root?.unmount()
  root = null
  container?.remove()
  container = null
})

describe('useTaskPageKanbanActions', () => {
  it('preselects the unique matching repo and opens the composer with kanban metadata', async () => {
    const host = renderActions([widgetsRepo])
    clickStart(host)
    await flushEffects()
    expect(openModalMock).toHaveBeenCalledTimes(1)
    const [modal, data] = openModalMock.mock.calls[0]
    expect(modal).toBe('new-workspace-composer')
    const linked = data.linkedWorkItem as LinkedWorkItemSummary
    expect(linked).toMatchObject({
      type: 'issue',
      provider: 'kanban',
      number: 0,
      title: 't1 Task one',
      url: 'https://kanban.fpimi.ru/?task=t1',
      kanbanIdentifier: 't1',
      repoId: 'repo-widgets'
    })
    expect(data.initialRepoId).toBe('repo-widgets')
    expect(data.taskSourceContext).toMatchObject({
      provider: 'kanban',
      repoId: 'repo-widgets',
      providerIdentity: { provider: 'kanban', serverUrl: 'https://kanban.fpimi.ru' }
    })
    expect(typeof data.prefilledName).toBe('string')
    expect(data.prefilledName.length).toBeGreaterThan(0)
  })

  it('seeds the startup draft with id, title, result, description, due and the deep link', async () => {
    const host = renderActions([widgetsRepo])
    clickStart(host)
    await flushEffects()
    const data = openModalMock.mock.calls[0][1]
    const linked = data.linkedWorkItem as LinkedWorkItemSummary
    const draft = linked.linkedContext?.renderedText ?? ''
    expect(draft).toContain('Kanban t1: Task one')
    expect(draft).toContain('Результат:')
    expect(draft).toContain('Expected result text')
    expect(draft).toContain('Описание:')
    expect(draft).toContain('Expected description text')
    expect(draft).toContain('Срок: 2026-08-28')
    expect(draft).toContain('Карточка: https://kanban.fpimi.ru/?task=t1')
  })

  it('leaves project selection open when no repo matches', async () => {
    const host = renderActions([])
    clickStart(host)
    await flushEffects()
    const data = openModalMock.mock.calls[0][1]
    const linked = data.linkedWorkItem as LinkedWorkItemSummary
    expect(linked.repoId).toBeUndefined()
    expect(data.initialRepoId).toBeUndefined()
    expect(data.taskSourceContext).toMatchObject({ provider: 'kanban', projectId: 't1' })
  })

  it('leaves project selection open when several repos match the same repository', async () => {
    const host = renderActions([
      widgetsRepo,
      { id: 'repo-widgets-2', gitRemoteIdentity: { remoteUrl: 'https://github.com/acme/widgets' } }
    ])
    clickStart(host)
    await flushEffects()
    const data = openModalMock.mock.calls[0][1]
    const linked = data.linkedWorkItem as LinkedWorkItemSummary
    expect(linked.repoId).toBeUndefined()
    expect(data.initialRepoId).toBeUndefined()
  })

  it('still supplies linked metadata and a complete draft when the detail fetch fails', async () => {
    kanbanApi.getTask.mockRejectedValue(new Error('network down'))
    const host = renderActions([widgetsRepo])
    clickStart(host)
    await flushEffects()
    expect(openModalMock).toHaveBeenCalledTimes(1)
    const data = openModalMock.mock.calls[0][1]
    const linked = data.linkedWorkItem as LinkedWorkItemSummary
    expect(linked).toMatchObject({
      provider: 'kanban',
      kanbanIdentifier: 't1',
      url: 'https://kanban.fpimi.ru/?task=t1'
    })
    const draft = linked.linkedContext?.renderedText ?? ''
    expect(draft).toContain('Срок: 2026-08-28')
    expect(draft).toContain('Карточка: https://kanban.fpimi.ru/?task=t1')
  })

  it('activates the existing worktree with its execution host instead of opening the composer on a duplicate Start', async () => {
    findLinkMock.mockReturnValue({
      kind: 'worktree',
      workspaceId: 'wt-1',
      executionHostId: 'ssh:host-a',
      worktree: {
        id: 'wt-1',
        isArchived: false,
        hostId: 'ssh:host-a',
        linkedWorkItem: {
          provider: 'kanban',
          type: 'issue',
          number: 0,
          title: 'Task',
          url: 'https://kanban.fpimi.ru/?task=t1',
          kanbanIdentifier: 't1'
        }
      }
    })
    const host = renderActions([widgetsRepo])
    clickStart(host)
    await flushEffects()
    expect(openModalMock).not.toHaveBeenCalled()
    expect(kanbanApi.getTask).not.toHaveBeenCalled()
    expect(activateWorkspaceMock).toHaveBeenCalledWith('wt-1', { executionHostId: 'ssh:host-a' })
    expect(findLinkMock).toHaveBeenCalledWith({
      worktrees: expect.any(Array),
      folderWorkspaces: expect.any(Array),
      taskId: 't1'
    })
  })

  it('activates the existing folder workspace with its execution host on a duplicate Start', async () => {
    findLinkMock.mockReturnValue({
      kind: 'folder',
      workspaceId: 'folder:fw-1',
      executionHostId: 'ssh:host-b',
      folderWorkspace: {
        id: 'fw-1',
        isArchived: false,
        executionHostId: 'ssh:host-b',
        linkedTask: {
          provider: 'kanban',
          type: 'issue',
          number: 0,
          title: 'Task',
          url: 'https://kanban.fpimi.ru/?task=t1',
          kanbanIdentifier: 't1'
        }
      }
    })
    const host = renderActions([])
    clickStart(host)
    await flushEffects()
    expect(openModalMock).not.toHaveBeenCalled()
    expect(kanbanApi.getTask).not.toHaveBeenCalled()
    expect(activateWorkspaceMock).toHaveBeenCalledWith('folder:fw-1', {
      executionHostId: 'ssh:host-b'
    })
  })

  it('forwards the matched host so a colliding local id cannot activate the wrong owner', async () => {
    findLinkMock.mockReturnValue({
      kind: 'worktree',
      workspaceId: 'wt-1',
      executionHostId: 'ssh:host-c',
      worktree: {
        id: 'wt-1',
        isArchived: false,
        hostId: 'ssh:host-c',
        linkedWorkItem: {
          provider: 'kanban',
          type: 'issue',
          number: 0,
          title: 'Task',
          url: 'https://kanban.fpimi.ru/?task=t1',
          kanbanIdentifier: 't1'
        }
      }
    })
    const host = renderActions([])
    clickStart(host)
    await flushEffects()
    expect(activateWorkspaceMock).toHaveBeenCalledWith('wt-1', { executionHostId: 'ssh:host-c' })
    expect(openModalMock).not.toHaveBeenCalled()
  })
})

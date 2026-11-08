// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JiraIssue, JiraTransition } from '../../../../../shared/jira/jira-types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'

const mocks = vi.hoisted(() => ({
  transitions: vi.fn(),
  apply: vi.fn(),
  patch: vi.fn(),
  refresh: vi.fn()
}))

vi.mock('@/store/index', () => ({
  useAppStore: (selector: (state: { patchJiraIssue: typeof mocks.patch }) => unknown) =>
    selector({ patchJiraIssue: mocks.patch })
}))
vi.mock('./task-page-jira-board-move', () => ({
  getJiraBoardMoveTransitions: mocks.transitions,
  applyJiraBoardMove: mocks.apply
}))

import { TaskPageJiraBoardView } from './task-page-jira-board-view'
import { TooltipProvider } from '@/components/ui/tooltip'

const source: TaskSourceContext = {
  kind: 'task-source',
  provider: 'jira',
  projectId: 'project',
  hostId: 'runtime:board-owner'
}
const target: RuntimeClientTarget = { kind: 'environment', environmentId: 'board-owner' }
const issue: JiraIssue = {
  id: '1',
  key: 'ABC-1',
  siteId: 'site-a',
  title: 'Ship the release',
  url: 'https://example.atlassian.net/browse/ABC-1',
  project: { id: 'p1', key: 'ABC', name: 'Example' },
  issueType: { id: 'task', name: 'Task' },
  status: { id: 'todo', name: 'To Do', categoryKey: 'new', categoryName: 'To Do' },
  labels: [],
  updatedAt: '2026-10-01T12:00:00Z',
  createdAt: '2026-10-01T12:00:00Z'
}
const transition: JiraTransition = {
  id: 'done',
  name: 'Complete',
  to: { id: 'done', name: 'Done', categoryKey: 'done', categoryName: 'Done' }
}

function mount(
  loading = false,
  owner: RuntimeClientTarget | null = target,
  sourceContext: TaskSourceContext | null = source
): ReturnType<typeof render> {
  return render(
    <TooltipProvider>
      <TaskPageJiraBoardView
        issues={[issue]}
        loading={loading}
        selectedIssue={null}
        sourceContext={sourceContext}
        target={owner}
        scopeKey="host-a"
        showSiteContext={false}
        onOpenIssue={vi.fn()}
        onStartWorkspace={vi.fn()}
        onRefresh={mocks.refresh}
        statusOrder={{
          statusIdsByColumn: [['todo'], ['done']],
          columns: [
            { name: 'To Do', statusIds: ['todo'] },
            { name: 'Done', statusIds: ['done'] }
          ]
        }}
      />
    </TooltipProvider>
  )
}

async function move(): Promise<void> {
  fireEvent.keyDown(screen.getByRole('button', { name: 'Move ABC-1' }), { key: 'ArrowDown' })
  const destination = await screen.findByRole('menuitem', { name: 'Done' })
  fireEvent.click(destination)
}

describe('Jira board moves', () => {
  afterEach(cleanup)
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.transitions.mockResolvedValue([transition])
    mocks.apply.mockResolvedValue({ result: { ok: true }, latest: null })
  })

  it('does not reopen or mutate after the user cancels a pending metadata request', async () => {
    let resolve: (value: JiraTransition[]) => void = () => {}
    mocks.transitions.mockReturnValue(
      new Promise<JiraTransition[]>((done) => {
        resolve = done
      })
    )
    mount()
    await move()
    await screen.findByRole('dialog')
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    await act(async () => {
      resolve([transition])
      await Promise.resolve()
    })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(mocks.apply).not.toHaveBeenCalled()
  })
})

// @vitest-environment happy-dom
import { reads, store, task } from './task-page-linear-refresh-test-fixtures'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { render, renderHook, screen, waitFor } from '@testing-library/react'
import LinearItemDrawer from '../../LinearItemDrawer'
import { useTaskPageLinearInOrcaEffects } from './use-task-page-linear-in-orca-effects'
import { useLinearIssueResult } from '@/hooks/linear-issue-committed-state'
import { getLinearSourceScope } from '@/store/slices/linear/linear-slice-scope'
import { defaultScopeSource } from '@/lib/default-creation-host'
import { getIssue } from '../../../../../main/linear/linear-issue-lookups'
import { createLinearClient, loadLinearSdk } from '../../../../../main/linear/linear-sdk'
import { ISSUE_QUERY } from '../../../../../main/linear/issue-context/raw'
import { linearIssueSchema } from '../../../../../../mobile/src/tasks/task-item-detail-reply-schema'
import type { LinearIssue } from '../../../../../shared/linear/issue-types'

const clients = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('../../../../../main/linear/client', () => ({
  getClients: clients.get,
  isAuthError: (error: unknown) => error instanceof loadLinearSdk().AuthenticationLinearError
}))
vi.mock('../../../../../main/linear/linear-token-store', () => ({ clearToken: vi.fn() }))

const child = {
  id: 'child',
  identifier: 'DAT-125',
  title: 'Child task',
  url: 'https://linear.app/acme/issue/DAT-125'
}
const project = {
  id: 'project',
  name: 'Release',
  url: 'https://linear.app/acme/project/release',
  color: '#888888'
}
const rawIssue = {
  ...task('Fresh'),
  branchName: 'dat-124',
  description: 'Full description',
  priority: 2,
  estimate: 3,
  dueDate: '2026-11-10',
  updatedAt: '2026-11-02T10:00:00-08:00',
  assignee: { id: 'user', displayName: 'Ada', avatarUrl: 'https://example.com/avatar' },
  project,
  labels: { nodes: [{ id: 'bug', name: 'Bug' }] },
  children: { nodes: [child] }
}
// The shared query returns the same first label page the drawer previously requested.
const { labelIds: _labelIds, ...responseIssue } = rawIssue
const expected = {
  ...task('Fresh'),
  branchName: rawIssue.branchName,
  description: rawIssue.description,
  priority: 2,
  estimate: 3,
  dueDate: rawIssue.dueDate,
  updatedAt: '2026-11-02T18:00:00.000Z',
  workspaceName: 'Acme',
  assignee: rawIssue.assignee,
  project,
  labels: ['Bug'],
  labelIds: ['bug'],
  subIssues: [child]
}
let requests: { query: string; variables: Record<string, unknown> }[]

beforeEach(() => {
  requests = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)))
    return Response.json({ data: { issue: responseIssue } })
  })
  clients.get.mockImplementation((_workspaceId: string, signal: AbortSignal) => [
    {
      workspace: { id: 'w', organizationName: 'Acme' },
      client: createLinearClient({ apiKey: 'test-only', signal })
    }
  ])
  reads.detail.mockImplementation((_source, id: string, workspaceId: string) =>
    getIssue(id, workspaceId)
  )
})
afterEach(() => vi.restoreAllMocks())

function expectQuery(index: number, id: string) {
  expect(requests[index]).toEqual({
    query: ISSUE_QUERY,
    variables: { id, includeDrawerFields: true }
  })
  expect(requests[index].query).toContain('children(first: 25)')
  expect(clients.get).toHaveBeenLastCalledWith('w', expect.any(AbortSignal))
}

it('forced drawer opens use one issue query and publish full detail for window and phone', async () => {
  const s = store()
  const drawer = render(<LinearItemDrawer issue={null} onUse={vi.fn()} onClose={vi.fn()} />)
  drawer.rerender(<LinearItemDrawer issue={task()} onUse={vi.fn()} onClose={vi.fn()} />)
  await waitFor(() => expect(screen.getByTestId('drawer').textContent).toBe('Fresh:2:Bug'))
  expect(requests).toHaveLength(1)
  expectQuery(0, task().id)
  const detail = s.getState().linearIssueCache[`w::${task().id}`].data
  expect(detail).toEqual(expected)
  expect(linearIssueSchema.parse(detail)).toEqual(expected)

  drawer.rerender(<LinearItemDrawer issue={null} onUse={vi.fn()} onClose={vi.fn()} />)
  drawer.rerender(<LinearItemDrawer issue={task()} onUse={vi.fn()} onClose={vi.fn()} />)
  await waitFor(() => expect(requests).toHaveLength(2))
  await waitFor(() => expect(screen.getByTestId('drawer').textContent).toBe('Fresh:2:Bug'))
  expectQuery(1, task().id)
})

it('linked-issue refresh uses one issue query and retains identifier and workspace routing', async () => {
  const s = store()
  const source = defaultScopeSource(null)
  const scope = getLinearSourceScope(source)
  const lastLinearRequestRef = { current: null }
  const linkedRefs = { current: [{ identifier: task().identifier, workspaceId: 'w' }] }
  const noop = () => {}
  const linked = renderHook(
    ({ nonce }) => {
      const result = useLinearIssueResult<LinearIssue[]>('linked', [], scope)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the linked loader only consumes these real slice actions, result ownership and request fields.
      useTaskPageLinearInOrcaEffects({
        ...s.getState(),
        linearConnected: true,
        selectedLinearWorkspaceId: 'w',
        taskSource: 'linear',
        linearTaskSourceContext: source,
        taskResumeApplied: true,
        linearMode: 'in-orca',
        setLinearIssues: result.setData,
        linearIssueResult: result,
        setLinearIssuesHasMore: noop,
        setLinearLoading: result.setLoading,
        setLinearError: result.setError,
        linearRefreshNonce: nonce,
        lastLinearRequestRef,
        inOrcaLinkedLinearRefsSignature: 'w::DAT-124',
        inOrcaLinkedLinearRefsRef: linkedRefs
      } as never)
      return result
    },
    { initialProps: { nonce: 0 } }
  )
  await waitFor(() => expect(linked.result.current.data).toEqual([expected]))
  expect(requests).toHaveLength(1)
  expectQuery(0, 'DAT-124')
  linked.rerender({ nonce: 1 })
  await waitFor(() => expect(requests).toHaveLength(2))
  await waitFor(() => expect(linked.result.current.loading).toBe(false))
  expect(linked.result.current.data).toEqual([expected])
  expect(linearIssueSchema.parse(linked.result.current.data[0])).toEqual(expected)
  expectQuery(1, 'DAT-124')
})

it('keeps readable core detail when an optional relation returns partial GraphQL errors', async () => {
  vi.mocked(globalThis.fetch).mockImplementation(async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)))
    return Response.json({
      data: {
        issue: { ...responseIssue, assignee: { ...responseIssue.assignee, avatarUrl: null } }
      },
      errors: [{ message: 'Avatar resolver failed', path: ['issue', 'assignee', 'avatarUrl'] }]
    })
  })
  await expect(getIssue(task().id, 'w')).resolves.toEqual({ ...expected, assignee: undefined })
  expect(requests).toHaveLength(1)
  expectQuery(0, task().id)
})

it.each([
  { path: ['issue', 'title'], extensions: undefined, auth: false },
  { path: ['issue', 'assignee'], extensions: { type: 'authentication error' }, auth: true }
])(
  'does not accept partial data for a core or authentication failure: $path',
  async ({ path, extensions, auth }) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(globalThis.fetch).mockResolvedValue(
      Response.json({
        data: { issue: responseIssue },
        errors: [{ message: 'Read failed', path, extensions }]
      })
    )
    const read = getIssue(task().id, 'w')
    await (auth ? expect(read).rejects.toThrow('Linear') : expect(read).resolves.toBeNull())
  }
)

// @vitest-environment happy-dom
import { reads, task } from './task-page-linear-refresh-test-fixtures'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { getIssue } from '../../../../../main/linear/issues/linear-issue-lookups'
import { createLinearClient, loadLinearSdk } from '../../../../../main/linear/requests/linear-sdk'
import { ISSUE_QUERY } from '../../../../../main/linear/issues/context/issue-context-graphql'

const clients = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('../../../../../main/linear/accounts/linear-account-client', () => ({
  getClients: clients.get,
  isAuthError: (error: unknown) => error instanceof loadLinearSdk().AuthenticationLinearError
}))
vi.mock('../../../../../main/linear/accounts/linear-token-store', () => ({ clearToken: vi.fn() }))

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

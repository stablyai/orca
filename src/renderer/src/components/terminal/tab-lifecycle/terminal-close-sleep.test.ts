import { beforeEach, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import { revalidateTerminalCloseSleep } from './terminal-close-sleep'

const probe = vi.hoisted(() => vi.fn())
let state: AppState
vi.mock('@/store/index', () => ({ useAppStore: { getState: () => state } }))
vi.mock('./pty-running-work-probe', () => ({ probePtyRunningWork: probe }))

const leaf = '11111111-1111-4111-8111-111111111111'
const agent = { agentType: 'claude', providerSession: { key: 'session_id', id: 'session-1' } }
const statuses = new Map<string, typeof agent>()

beforeEach(() => {
  statuses.clear()
  statuses.set(`tab-1:${leaf}`, agent)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only terminal inventory and agent evidence are read by the preflight.
  state = {
    repos: [{ id: 'repo-1', path: '/tmp/project' }],
    worktreesByRepo: { 'repo-1': [{ id: 'wt-1', repoId: 'repo-1' }] },
    detectedWorktreesByRepo: {},
    runtimeEnvironments: [],
    runtimeEnvironmentCatalogHydrated: true,
    removedRuntimeEnvironmentIds: new Set(),
    tabsByWorktree: { 'wt-1': [{ id: 'tab-1' }, { id: 'tab-2' }] },
    unifiedTabsByWorktree: {},
    ptyIdsByTabId: { 'tab-1': ['pty-1'], 'tab-2': ['pty-2'] },
    terminalLayoutsByTabId: {
      'tab-1': { ptyIdsByLeafId: { [leaf]: 'pty-1' } },
      'tab-2': { ptyIdsByLeafId: { [leaf]: 'pty-2' } }
    },
    agentStatusByPaneKey: statuses,
    ephemeralVmRuntimesByWorkspaceId: {}
  } as unknown as AppState
  probe.mockReset().mockResolvedValue([
    { ptyId: 'pty-1', verdict: 'live', timedOut: false },
    { ptyId: 'pty-2', verdict: 'live', timedOut: false }
  ])
})

it('refuses a running command in a sibling tab even when the closing agent can resume', async () => {
  expect(await revalidateTerminalCloseSleep('wt-1', 'tab-1')).toBe(false)
})

it('allows sleep when every currently busy workspace pane can resume', async () => {
  statuses.set(`tab-2:${leaf}`, agent)
  expect(await revalidateTerminalCloseSleep('wt-1', 'tab-1')).toBe(true)
})

it('refuses an unverifiable process instead of stopping unknown work', async () => {
  probe.mockResolvedValue([{ ptyId: 'pty-1', verdict: 'unverifiable', timedOut: true }])
  expect(await revalidateTerminalCloseSleep('wt-1', 'tab-1')).toBe(false)
})

it.each([
  { verdict: 'live', allowed: false },
  { verdict: 'unverifiable', allowed: false },
  { verdict: 'exited', allowed: true }
])(
  'rechecks an idle shell and handles its final $verdict verdict',
  async ({ verdict, allowed }) => {
    probe
      .mockResolvedValueOnce([
        { ptyId: 'pty-1', verdict: 'live', timedOut: false },
        { ptyId: 'pty-2', verdict: 'exited', timedOut: false }
      ])
      .mockResolvedValueOnce([{ ptyId: 'pty-2', verdict, timedOut: false }])
    expect(await revalidateTerminalCloseSleep('wt-1', 'tab-1')).toBe(allowed)
  }
)

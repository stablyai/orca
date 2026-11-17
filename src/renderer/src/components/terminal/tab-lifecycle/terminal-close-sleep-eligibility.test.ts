import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import { canSleepInsteadOfClosingTab } from './terminal-close-sleep-eligibility'
import { resolveTerminalPtyOwner } from '@/lib/workspace/ownership/terminal-worktree-route'

const worktrees = vi.hoisted(
  () => new Map<string, { id: string; hostId?: string; runtimeOwnerEnvironmentId?: string }>()
)
const windowKind = vi.hoisted(() => ({ pairedWeb: false }))
vi.mock('@/app-shell/chrome/desktop-window-chrome', () => ({
  isPairedWebClientWindow: () => windowKind.pairedWeb
}))
beforeEach(() => {
  windowKind.pairedWeb = false
})

const LEAF = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = `tab-1:${LEAF}`
const SESSION = { key: 'session_id', id: 'claude-session-1' } as const

function stateWith(
  entry: Record<string, unknown>,
  vmWorkspace = false,
  repoHostId?: string
): AppState {
  const worktree = worktrees.get('wt-1')
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the named workspace, ownership, layout and agent slices are read.
  return {
    repos: [
      {
        id: 'repo-1',
        path: '/tmp/project',
        connectionId: worktree?.hostId?.startsWith('ssh:') ? 'devbox-2' : undefined,
        executionHostId: repoHostId
      }
    ],
    worktreesByRepo: { 'repo-1': [{ ...worktree, repoId: 'repo-1' }] },
    detectedWorktreesByRepo: {},
    runtimeEnvironments: [{ id: 'env-1' }],
    runtimeEnvironmentCatalogHydrated: true,
    removedRuntimeEnvironmentIds: new Set(),
    settings: { activeRuntimeEnvironmentId: null },
    agentStatusByPaneKey: new Map([[PANE_KEY, entry]]),
    terminalLayoutsByTabId: { 'tab-1': { ptyIdsByLeafId: { [LEAF]: 'pty-1' } } },
    ephemeralVmRuntimesByWorkspaceId: vmWorkspace ? { 'wt-1': { id: 'vm-1' } } : {}
  } as unknown as AppState
}

function eligible(state: AppState): boolean {
  return canSleepInsteadOfClosingTab(state, {
    worktreeId: 'wt-1',
    terminalTabId: 'tab-1',
    busyPtyIds: ['pty-1']
  })
}

describe('canSleepInsteadOfClosingTab', () => {
  it('refuses an unstamped legacy workspace whose repository has competing terminal owners', () => {
    worktrees.set('wt-1', { id: 'wt-1' })
    const state = stateWith({ agentType: 'claude', providerSession: SESSION }, false, 'local')
    state.repos = [...state.repos, { ...state.repos[0], executionHostId: 'runtime:env-1' }]
    expect(resolveTerminalPtyOwner(state, 'wt-1')).toEqual({ kind: 'ambiguous' })
    expect(eligible(state)).toBe(false)
  })
  it('hides sleep for paired browsers independently of catalog hydration or server count', () => {
    worktrees.set('wt-1', { id: 'wt-1', hostId: 'local' })
    windowKind.pairedWeb = true
    const state = stateWith({ agentType: 'claude', providerSession: SESSION })
    expect(eligible(state)).toBe(false)
    expect(eligible({ ...state, runtimeEnvironments: [] })).toBe(false)
    expect(
      eligible({
        ...state,
        runtimeEnvironments: [
          ...state.runtimeEnvironments,
          { ...state.runtimeEnvironments[0], id: 'env-2' }
        ]
      })
    ).toBe(false)
  })
  it('refuses contested catalog owners even when focus selects the local copy', () => {
    worktrees.set('wt-1', { id: 'wt-1', hostId: 'local' })
    const state = stateWith({ agentType: 'claude', providerSession: SESSION })
    state.worktreesByRepo['repo-1'].push({
      ...state.worktreesByRepo['repo-1'][0],
      hostId: 'runtime:env-1'
    })
    state.activeWorktreeId = 'wt-1'
    state.activeWorkspaceExecutionHostId = 'local'
    expect(eligible(state)).toBe(false)
  })
  it('uses terminal ownership for SSH aliases and legacy rows owned by a paired runtime', () => {
    const resumable = { agentType: 'claude', providerSession: SESSION }
    worktrees.set('wt-1', {
      id: 'wt-1',
      hostId: 'ssh:devbox-2',
      runtimeOwnerEnvironmentId: 'env-1'
    })
    const alias = stateWith(resumable)
    expect(resolveTerminalPtyOwner(alias, 'wt-1')).toEqual({
      kind: 'runtime',
      environmentId: 'env-1'
    })
    expect(eligible(alias)).toBe(false)
    worktrees.set('wt-1', { id: 'wt-1' })
    const legacy = stateWith(resumable, false, 'runtime:env-1')
    expect(resolveTerminalPtyOwner(legacy, 'wt-1')).toEqual({
      kind: 'runtime',
      environmentId: 'env-1'
    })
    expect(eligible(legacy)).toBe(false)
  })
  it('refuses a busy PTY with no mapped pane even when another busy agent can resume', () => {
    worktrees.set('wt-1', { id: 'wt-1', hostId: 'local' })
    expect(
      canSleepInsteadOfClosingTab(stateWith({ agentType: 'claude', providerSession: SESSION }), {
        worktreeId: 'wt-1',
        terminalTabId: 'tab-1',
        busyPtyIds: ['pty-1', 'unmapped-pty']
      })
    ).toBe(false)
  })
})

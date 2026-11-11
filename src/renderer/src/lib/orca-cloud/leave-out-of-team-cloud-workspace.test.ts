import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import { installLeaveOutOfTeamCloudWorkspace } from './leave-out-of-team-cloud-workspace'

const environments = [
  { id: 'cusk', name: 'push-test sandbox 1a2b3c4d', source: 'ephemeral-vm' },
  { id: 'otter', name: 'push-test sandbox 5e6f7a8b', source: 'ephemeral-vm' }
]
const owners = { cusk: 'org:team-one', otter: 'org:team-two' }

type State = Parameters<typeof installLeaveOutOfTeamCloudWorkspace>[0] extends {
  getState: () => infer S
}
  ? S
  : never

function harness(initial: { activeHost: string | null; activeOrgId?: string }) {
  const setActiveWorktree = vi.fn((id: string | null) => {
    state = { ...state, activeWorktreeId: id, activeWorkspaceExecutionHostId: null }
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the observer reads only these fields.
  let state = {
    activeWorktreeId: initial.activeHost ? 'repo::/w/cusk' : null,
    activeWorkspaceExecutionHostId: initial.activeHost,
    folderWorkspaces: [],
    projectGroups: [],
    repos: [],
    runtimeEnvironments: environments,
    cloudAccountIdByEnvironmentId: owners,
    orcaProfileAuthStatus: initial.activeOrgId
      ? { cloud: { userId: 'u1', activeOrgId: initial.activeOrgId } }
      : null,
    setActiveWorktree
  } as unknown as State
  const listeners = new Set<(next: State) => void>()
  const store = {
    getState: () => state,
    subscribe: (listener: (next: State) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
  installLeaveOutOfTeamCloudWorkspace(store)
  const set = (patch: Partial<AppState>): void => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test patches only fields the observer reads.
    state = { ...state, ...patch } as State
    listeners.forEach((listener) => listener(state))
  }
  return { set, setActiveWorktree, active: () => state.activeWorktreeId }
}

function team(activeOrgId: string): Partial<AppState> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only `cloud` is read.
  return { orcaProfileAuthStatus: { cloud: { userId: 'u1', activeOrgId } } } as Partial<AppState>
}

describe('leaving an out-of-team cloud workspace', () => {
  it('moves off the open cloud workspace when its team is switched away', () => {
    const h = harness({ activeHost: 'runtime:cusk', activeOrgId: 'team-one' })
    h.set(team('team-two'))
    expect(h.setActiveWorktree).toHaveBeenCalledWith(null)
    expect(h.setActiveWorktree).toHaveBeenCalledTimes(1)
    expect(h.active()).toBeNull()
  })

  it('moves off it on sign-out too', () => {
    const h = harness({ activeHost: 'runtime:cusk', activeOrgId: 'team-one' })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only `cloud` is read.
    h.set({ orcaProfileAuthStatus: null } as Partial<AppState>)
    expect(h.active()).toBeNull()
  })

  it('stays on a local workspace, or on the cloud workspace of the team switched to', () => {
    const local = harness({ activeHost: 'local', activeOrgId: 'team-one' })
    local.set(team('team-two'))
    expect(local.setActiveWorktree).not.toHaveBeenCalled()

    const otter = harness({ activeHost: 'runtime:otter', activeOrgId: 'team-one' })
    otter.set(team('team-two'))
    expect(otter.setActiveWorktree).not.toHaveBeenCalled()
  })

  it('keeps a restored cloud workspace while the team and runtimes are still loading', () => {
    // Launch: no auth status yet, so every sandbox reads as out of scope until it loads.
    const h = harness({ activeHost: 'runtime:cusk' })
    h.set(team('team-one'))
    expect(h.setActiveWorktree).not.toHaveBeenCalled()
    expect(h.active()).toBe('repo::/w/cusk')
  })
})

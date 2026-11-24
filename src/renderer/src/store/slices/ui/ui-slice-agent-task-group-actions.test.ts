import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import { createAgentTaskGroupActions } from './ui-slice-agent-task-group-actions'
import { selectWorkspaceAgentTaskGroups } from './agent-task-group-source'
import { composeWorktreeHostIdentity } from '../../../../../shared/worktree/host-qualified-identity'
import type { UISliceGet, UISliceSet } from './ui-slice-contract'

const HOST = 'local' as const

function fakeState(fields: Record<string, unknown>): AppState {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the actions read only the fields given here.
  return fields as unknown as AppState
}
const WORKTREE = 'repo-1::/work/courses'

function harness(options: { listed: boolean; hostSaves: boolean }) {
  const updateWorktreeMeta = vi.fn(
    async (_id: string, updates: Record<string, unknown>, _options?: unknown) => {
      if (!options.hostSaves) {
        return { ok: false as const, error: 'old host' }
      }
      // Mirrors the meta update's optimistic write onto the listed row.
      const row = state.worktreesByRepo['repo-1'][0]
      state.worktreesByRepo = { 'repo-1': [{ ...row, ...updates }] }
      return { ok: true as const }
    }
  )
  let state = fakeState({
    agentTaskGroupsByWorkspace: {},
    worktreesByRepo: options.listed
      ? { 'repo-1': [{ id: WORKTREE, repoId: 'repo-1', hostId: HOST }] }
      : {},
    updateWorktreeMeta
  })
  const set: UISliceSet = (
    partial: AppState | Partial<AppState> | ((s: AppState) => AppState | Partial<AppState>)
  ) => {
    state = { ...state, ...(typeof partial === 'function' ? partial(state) : partial) }
  }
  const get: UISliceGet = () => state
  const actions = createAgentTaskGroupActions(set, get)
  return {
    actions,
    updateWorktreeMeta,
    groups: () => selectWorkspaceAgentTaskGroups(state, WORKTREE, HOST),
    deviceGroups: () => state.agentTaskGroupsByWorkspace
  }
}

const KEY = composeWorktreeHostIdentity(HOST, WORKTREE)

describe('task groups kept with the workspace on its host', () => {
  it("saves a listed git workspace's groups with its host, not on this device", async () => {
    const h = harness({ listed: true, hostSaves: true })
    const id = h.actions.createAgentTaskGroup(KEY, 'PA4', null)
    await vi.waitFor(() => expect(h.updateWorktreeMeta).toHaveBeenCalledTimes(1))
    const [worktreeId, updates, options] = h.updateWorktreeMeta.mock.calls[0]
    expect(worktreeId).toBe(WORKTREE)
    expect(options).toEqual({ executionHostId: HOST })
    expect(updates).toMatchObject({ agentTaskGroups: { groups: [{ id, name: 'PA4' }] } })
    expect(h.groups()?.groups.map((group) => group.name)).toEqual(['PA4'])
    expect(h.deviceGroups()).toEqual({})
  })

  it('keeps groups on this device when the host is too old to hold them', async () => {
    const h = harness({ listed: true, hostSaves: false })
    h.actions.createAgentTaskGroup(KEY, 'PA4', null)
    await vi.waitFor(() => expect(h.deviceGroups()[KEY]?.groups).toHaveLength(1))
  })

  it('keeps groups on this device for a workspace no host lists', () => {
    const h = harness({ listed: false, hostSaves: true })
    h.actions.createAgentTaskGroup(KEY, 'PA4', null)
    expect(h.updateWorktreeMeta).not.toHaveBeenCalled()
    expect(h.groups()?.groups.map((group) => group.name)).toEqual(['PA4'])
  })
})

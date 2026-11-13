import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'

vi.mock('../../../../../lib/workspace/ownership/workspace-runtime-environment', () => ({
  selectWorkspaceRuntimeEnvironmentId: (_state: unknown, worktreeId: string | null) =>
    worktreeId === 'wt-pick' ? 'pick' : null
}))
vi.mock('@/runtime/hosts/connections/runtime-host-connection-state', () => ({
  runtimeHostConnectionStateForEntry: (entry: { reconnecting?: boolean } | undefined) =>
    entry?.reconnecting ? 'reconnecting' : 'connected'
}))

import { selectRetryingOutageEnvironmentId } from './remote-server-outage'

function state(activeOrgId: string): AppState {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the selectors read only these fields.
  return {
    runtimeEnvironments: [
      {
        id: 'pick',
        name: 'endpass-pick (cloud)',
        orcaCloudPaired: true,
        orcaCloudPairedAccountId: 'org:eval'
      }
    ],
    cloudAccountIdByEnvironmentId: {},
    orcaProfileAuthStatus: { cloud: { userId: 'u1', activeOrgId } },
    runtimeStatusByEnvironmentId: new Map([['pick', { reconnecting: true }]])
  } as unknown as AppState
}

describe('reconnect banner scope (STALE-RUN-TARGET)', () => {
  it("announces the active team's cloud workspace reconnecting", () => {
    expect(selectRetryingOutageEnvironmentId(state('eval'), 'wt-pick')).toBe('pick')
  })

  it("stays quiet for another team's cloud workspace, which the sidebar hides too", () => {
    expect(selectRetryingOutageEnvironmentId(state('noplan'), 'wt-pick')).toBeNull()
  })
})

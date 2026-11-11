import { beforeEach, describe, expect, it } from 'vitest'
import type { WorktreeCreationRequest } from '@/lib/workspace/creation/pending-worktree-creation'
import { resolveBackendDraftStartup } from '@/lib/workspace/creation/worktree-draft-startup-view-mode'
import type { OrcaCloudAgentsStatus } from '../../../../shared/orca-cloud-agents/orca-cloud-agents-wire'
import {
  setOrcaCloudAgentAccountsStateForTest,
  type OrcaCloudAgentAccountsState
} from './orca-cloud-agent-accounts-store'
import { withholdsCloudAgentBackendStartup } from './cloud-create-agent-startup'

function accounts(
  claude: OrcaCloudAgentsStatus['credentials']['claude'] | 'loading'
): OrcaCloudAgentAccountsState {
  return {
    load:
      claude === 'loading'
        ? { kind: 'loading' }
        : {
            kind: 'ready',
            status: {
              credentials: {
                claude,
                codex: { state: 'none' },
                providerEnabled: { claude: true, codex: true }
              },
              sources: { defaults: {}, coveredByKey: { claude: false, codex: false } }
            }
          },
    setups: { claude: { phase: 'idle' }, codex: { phase: 'idle' } },
    keyKinds: { claude: null, codex: null },
    queue: { agents: [], index: 0 }
  }
}

const STARTUP = { command: "claude 'fix the typo'" }

function request(
  overrides: Partial<Pick<WorktreeCreationRequest, 'agent' | 'ephemeralVmRecipe'>> = {}
): WorktreeCreationRequest {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the startup path reads only these fields
  return {
    agent: 'claude',
    startup: STARTUP,
    ephemeralVmRecipe: {
      sourceRepoId: 'repo',
      recipeId: 'cloud',
      projectId: 'project',
      provider: 'orca-cloud'
    },
    ...overrides
  } as WorktreeCreationRequest
}

describe('Orca Cloud create: no host draft startup while the agent is held (PC-3b)', () => {
  beforeEach(() => {
    setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'none' }))
  })

  it('withholds the startup (and its prompt) when Claude is not set up', () => {
    expect(withholdsCloudAgentBackendStartup(request())).toBe(true)
    expect(resolveBackendDraftStartup(request())).toBeUndefined()
  })

  it('withholds while the first account read is loading (the pane gate waits for it)', () => {
    setOrcaCloudAgentAccountsStateForTest(accounts('loading'))
    expect(resolveBackendDraftStartup(request())).toBeUndefined()
  })

  it('withholds for an expired account too', () => {
    setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'expired' }))
    expect(resolveBackendDraftStartup(request())).toBeUndefined()
  })

  it('keeps the host startup once Claude is signed in', () => {
    setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'active' }))
    expect(resolveBackendDraftStartup(request())).toEqual(STARTUP)
  })

  it('never touches local or custom-environment creates', () => {
    expect(resolveBackendDraftStartup(request({ ephemeralVmRecipe: undefined }))).toEqual(STARTUP)
    expect(
      resolveBackendDraftStartup(
        request({
          ephemeralVmRecipe: { sourceRepoId: 'repo', recipeId: 'devbox', projectId: 'project' }
        })
      )
    ).toEqual(STARTUP)
  })

  it('leaves agents without an Orca Cloud account alone', () => {
    expect(resolveBackendDraftStartup(request({ agent: 'opencode' }))).toEqual(STARTUP)
  })
})

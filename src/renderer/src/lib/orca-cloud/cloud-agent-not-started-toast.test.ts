import { beforeEach, describe, expect, it, vi } from 'vitest'

const toastMock = vi.hoisted(() => ({ message: vi.fn(), dismiss: vi.fn() }))
vi.mock('sonner', () => ({ toast: toastMock }))
vi.mock('@/components/new-workspace/OrcaCloudAgentSetupRow', () => ({
  openOrcaCloudAgentAccounts: vi.fn()
}))

import { useAppStore } from '@/store/index'
import type { OrcaCloudAgentsStatus } from '../../../../shared/orca-cloud-agents/orca-cloud-agents-wire'
import {
  setOrcaCloudAgentAccountsStateForTest,
  type OrcaCloudAgentAccountsState
} from './orca-cloud-agent-accounts-store'
import {
  cloudAgentNotStartedMessage,
  showCloudAgentNotStartedToast
} from './cloud-agent-not-started-toast'

function accounts(
  claude: OrcaCloudAgentsStatus['credentials']['claude']
): OrcaCloudAgentAccountsState {
  return {
    load: {
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

describe('cloud agent not-started toast', () => {
  beforeEach(() => {
    toastMock.message.mockClear()
    toastMock.dismiss.mockClear()
    setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'none' }))
    useAppStore.setState({ activeWorktreeId: null })
  })

  it('says it once, with no extra sentence, and names the workspace only after a switch', () => {
    expect(cloudAgentNotStartedMessage('Claude', null)).toBe(
      'Claude isn’t set up for Orca Cloud, so it didn’t start.'
    )
    expect(cloudAgentNotStartedMessage('Claude', 'fix-readme-typo')).toBe(
      'Claude isn’t set up for Orca Cloud, so it didn’t start in fix-readme-typo.'
    )
    showCloudAgentNotStartedToast('claude', 'fix-readme-typo')
    expect(toastMock.message).toHaveBeenLastCalledWith(
      'Claude isn’t set up for Orca Cloud, so it didn’t start.',
      expect.objectContaining({
        id: 'orca-cloud-agent-not-started',
        action: expect.objectContaining({ label: 'Set up Claude once' })
      })
    )
    // The create activates the new workspace, then the user moves elsewhere.
    useAppStore.setState({ activeWorktreeId: 'repo::new' })
    expect(toastMock.message).toHaveBeenCalledTimes(1)
    useAppStore.setState({ activeWorktreeId: 'repo::other' })
    expect(toastMock.message).toHaveBeenLastCalledWith(
      'Claude isn’t set up for Orca Cloud, so it didn’t start in fix-readme-typo.',
      expect.anything()
    )
  })

  it('clears itself once the agent account turns active', () => {
    showCloudAgentNotStartedToast('claude', 'w')
    setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'expired' }))
    expect(toastMock.dismiss).not.toHaveBeenCalled()
    setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'active' }))
    expect(toastMock.dismiss).toHaveBeenCalledWith('orca-cloud-agent-not-started')
  })
})

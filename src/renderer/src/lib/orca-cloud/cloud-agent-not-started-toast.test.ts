// @vitest-environment happy-dom
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

  it('"Set up Claude once" starts the sign-in right from the toast, which stays up', () => {
    const start = vi.fn(async () => undefined)
    Object.assign(window, {
      api: {
        orcaCloudAgents: {
          start,
          setups: vi.fn(async () => ({ claude: { phase: 'idle' }, codex: { phase: 'idle' } })),
          onSetupChanged: vi.fn(() => () => undefined)
        }
      }
    })
    showCloudAgentNotStartedToast('claude', 'w')
    const options: {
      duration: number
      action: { onClick: (event: { preventDefault: () => void }) => void }
    } = toastMock.message.mock.calls.at(-1)?.[1]
    expect(options.duration).toBe(Number.POSITIVE_INFINITY)
    const preventDefault = vi.fn()
    options.action.onClick({ preventDefault })
    expect(preventDefault).toHaveBeenCalled()
    expect(start).toHaveBeenCalledWith({ agent: 'claude' })
  })

  it('in the workspace itself it stays hidden (its pane strip asks); away, it names it', () => {
    showCloudAgentNotStartedToast('claude', 'fix-readme-typo', { onlyWhenAway: true })
    expect(toastMock.message).not.toHaveBeenCalled()
    useAppStore.setState({ activeWorktreeId: 'repo::new' })
    useAppStore.setState({ activeWorktreeId: 'repo::other' })
    expect(toastMock.message).toHaveBeenLastCalledWith(
      'Claude isn’t set up for Orca Cloud, so it didn’t start in fix-readme-typo.',
      expect.anything()
    )
  })

  it('says it won’t start while the sandbox is starting, then didn’t start once ready', () => {
    expect(cloudAgentNotStartedMessage('Claude', null, { starting: true })).toBe(
      'Claude isn’t set up for Orca Cloud, so it won’t start.'
    )
    useAppStore.setState({
      pendingWorktreeCreations: {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the toast reads only status and request.name
        c1: { status: 'creating', request: { name: 'w' } } as never
      }
    })
    showCloudAgentNotStartedToast('claude', 'w')
    expect(toastMock.message).toHaveBeenLastCalledWith(
      'Claude isn’t set up for Orca Cloud, so it won’t start.',
      expect.anything()
    )
    useAppStore.setState({ pendingWorktreeCreations: {} })
    expect(toastMock.message).toHaveBeenLastCalledWith(
      'Claude isn’t set up for Orca Cloud, so it didn’t start.',
      expect.anything()
    )
  })
})

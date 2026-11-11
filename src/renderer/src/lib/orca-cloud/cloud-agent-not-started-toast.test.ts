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

/** The create for `name` runs (`phase`) and then finishes: the sandbox is up, the prompt may show. */
function creation(name: string, phase: string, status = 'creating'): void {
  useAppStore.setState({
    pendingWorktreeCreations: {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the toast reads only these fields
      c1: { creationId: 'c1', startedAt: Date.now(), status, phase, request: { name } } as never
    }
  })
}
function created(name: string): void {
  creation(name, 'creating')
  useAppStore.setState({ pendingWorktreeCreations: {} })
}

describe('cloud agent not-started toast', () => {
  beforeEach(() => {
    toastMock.message.mockClear()
    toastMock.dismiss.mockClear()
    setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'none' }))
    useAppStore.setState({ activeWorktreeId: null, pendingWorktreeCreations: {} })
  })

  it('says it once, with no extra sentence, and names the workspace only after a switch', () => {
    expect(cloudAgentNotStartedMessage('Claude', null)).toBe(
      'Claude isn’t set up for Orca Cloud, so it didn’t start.'
    )
    expect(cloudAgentNotStartedMessage('Claude', 'fix-readme-typo')).toBe(
      'Claude isn’t set up for Orca Cloud, so it didn’t start in fix-readme-typo.'
    )
    showCloudAgentNotStartedToast('claude', 'fix-readme-typo')
    created('fix-readme-typo')
    expect(toastMock.message).toHaveBeenLastCalledWith(
      'Claude isn’t set up for Orca Cloud, so it didn’t start.',
      expect.objectContaining({
        id: 'orca-cloud-agent-not-started',
        action: expect.objectContaining({ label: 'Set up Claude once' })
      })
    )
    // The create activates the new workspace, then the user moves elsewhere.
    toastMock.message.mockClear()
    useAppStore.setState({ activeWorktreeId: 'repo::new' })
    expect(toastMock.message).not.toHaveBeenCalled()
    useAppStore.setState({ activeWorktreeId: 'repo::other' })
    expect(toastMock.message).toHaveBeenLastCalledWith(
      'Claude isn’t set up for Orca Cloud, so it didn’t start in fix-readme-typo.',
      expect.anything()
    )
  })

  it('clears itself once the agent account turns active', () => {
    showCloudAgentNotStartedToast('claude', 'w')
    created('w')
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
    created('w')
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
    created('fix-readme-typo')
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
    showCloudAgentNotStartedToast('claude', 'w')
    // Still provisioning: nothing has started yet, so no prompt (DS-p).
    creation('w', 'provisioning-vm')
    expect(toastMock.message).not.toHaveBeenCalled()
    creation('w', 'fetching')
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

  it('a refused create (the running limit) never shows the agent prompt (DS-p)', () => {
    showCloudAgentNotStartedToast('claude', 'w')
    creation('w', 'provisioning-vm')
    creation('w', 'provisioning-vm', 'error')
    useAppStore.setState({ pendingWorktreeCreations: {} })
    expect(toastMock.message).not.toHaveBeenCalled()
  })

  it('follows the create it was asked for even when its name is generated later (DS-p)', () => {
    // An empty name field: the create names the workspace itself ("chinook").
    showCloudAgentNotStartedToast('claude', '')
    creation('chinook', 'provisioning-vm')
    expect(toastMock.message).not.toHaveBeenCalled()
    useAppStore.setState({ pendingWorktreeCreations: {} })
    expect(toastMock.message).toHaveBeenLastCalledWith(
      'Claude isn’t set up for Orca Cloud, so it didn’t start.',
      expect.anything()
    )
    // Away from it, the toast names the real workspace, not the empty field.
    useAppStore.setState({ activeWorktreeId: 'chinook-id' })
    useAppStore.setState({ activeWorktreeId: 'other' })
    expect(toastMock.message).toHaveBeenLastCalledWith(
      'Claude isn’t set up for Orca Cloud, so it didn’t start in chinook.',
      expect.anything()
    )
  })
})

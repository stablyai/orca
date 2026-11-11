// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CloudToastView } from '@/components/orca-cloud/cloud-toast-stack'

const stack = vi.hoisted(() => ({ show: vi.fn(), hide: vi.fn() }))
vi.mock('@/components/orca-cloud/cloud-toast-stack', () => ({
  showCloudToast: stack.show,
  hideCloudToast: stack.hide
}))
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

const TOAST_ID = 'orca-cloud-agent-not-started'

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

/** The last view shown for the agent toast. */
function lastView(): CloudToastView | undefined {
  const call = stack.show.mock.calls.findLast((args) => args[0] === TOAST_ID)
  return call?.[1]
}
function lastText(): string | undefined {
  return lastView()?.lines[0]?.text
}

const NOW = 1_800_000_000_000

/** The create for `name` runs (`phase`) and then finishes: the sandbox is up, the prompt may show. */
function creation(name: string, phase: string, status = 'creating'): void {
  useAppStore.setState({
    pendingWorktreeCreations: {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the toast reads only these fields
      c1: { creationId: 'c1', startedAt: NOW, status, phase, request: { name } } as never
    }
  })
}
function created(name: string): void {
  creation(name, 'creating')
  useAppStore.setState({ pendingWorktreeCreations: {} })
}

describe('cloud agent not-started toast', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW })
    stack.show.mockClear()
    stack.hide.mockClear()
    setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'none' }))
    useAppStore.setState({ activeWorktreeId: null, pendingWorktreeCreations: {} })
  })
  afterEach(() => {
    vi.useRealTimers()
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
    expect(lastText()).toBe('Claude isn’t set up for Orca Cloud, so it didn’t start.')
    // DS-q: an action-required prompt, with "Set up Claude once" as the one primary button.
    expect(lastView()?.priority).toBe('action')
    expect(lastView()?.lines[0]?.action).toMatchObject({
      label: 'Set up Claude once',
      primary: true
    })
    // The create activates the new workspace, then the user moves elsewhere.
    stack.show.mockClear()
    useAppStore.setState({ activeWorktreeId: 'repo::new' })
    expect(stack.show).not.toHaveBeenCalled()
    useAppStore.setState({ activeWorktreeId: 'repo::other' })
    expect(lastText()).toBe(
      'Claude isn’t set up for Orca Cloud, so it didn’t start in fix-readme-typo.'
    )
  })

  it('clears itself once the agent account turns active', () => {
    showCloudAgentNotStartedToast('claude', 'w')
    created('w')
    setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'expired' }))
    expect(stack.hide).not.toHaveBeenCalled()
    setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'active' }))
    expect(stack.hide).toHaveBeenCalledWith(TOAST_ID)
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
    lastView()?.lines[0]?.action?.onClick()
    expect(start).toHaveBeenCalledWith({ agent: 'claude' })
    expect(stack.hide).not.toHaveBeenCalled()
  })

  it('a close by the user (by its logical id) ends the prompt for good', () => {
    showCloudAgentNotStartedToast('claude', 'w')
    created('w')
    const options = stack.show.mock.calls.findLast((args) => args[0] === TOAST_ID)?.[2]
    options?.onDismiss?.()
    stack.show.mockClear()
    // Nothing brings it back afterwards: a switch away no longer re-shows it.
    useAppStore.setState({ activeWorktreeId: 'repo::new' })
    useAppStore.setState({ activeWorktreeId: 'repo::other' })
    expect(stack.show).not.toHaveBeenCalled()
  })

  it('in the workspace itself it stays hidden (its pane strip asks); away, it names it', () => {
    showCloudAgentNotStartedToast('claude', 'fix-readme-typo', { onlyWhenAway: true })
    created('fix-readme-typo')
    expect(stack.show).not.toHaveBeenCalled()
    useAppStore.setState({ activeWorktreeId: 'repo::new' })
    useAppStore.setState({ activeWorktreeId: 'repo::other' })
    expect(lastText()).toBe(
      'Claude isn’t set up for Orca Cloud, so it didn’t start in fix-readme-typo.'
    )
  })

  it('says it won’t start while the sandbox is starting, then didn’t start once ready', () => {
    expect(cloudAgentNotStartedMessage('Claude', null, { starting: true })).toBe(
      'Claude isn’t set up for Orca Cloud, so it won’t start.'
    )
    showCloudAgentNotStartedToast('claude', 'w')
    // Still provisioning: nothing has started yet, so no prompt (DS-p).
    creation('w', 'provisioning-vm')
    expect(stack.show).not.toHaveBeenCalled()
    creation('w', 'fetching')
    expect(lastText()).toBe('Claude isn’t set up for Orca Cloud, so it won’t start.')
    useAppStore.setState({ pendingWorktreeCreations: {} })
    expect(lastText()).toBe('Claude isn’t set up for Orca Cloud, so it didn’t start.')
  })

  it('a refused create (the running limit) never shows the agent prompt (DS-p)', () => {
    showCloudAgentNotStartedToast('claude', 'w')
    creation('w', 'provisioning-vm')
    creation('w', 'provisioning-vm', 'error')
    useAppStore.setState({ pendingWorktreeCreations: {} })
    expect(stack.show).not.toHaveBeenCalled()
  })

  it('follows the create it was asked for even when its name is generated later (DS-p)', () => {
    // An empty name field: the create names the workspace itself ("chinook").
    showCloudAgentNotStartedToast('claude', '')
    creation('chinook', 'provisioning-vm')
    expect(stack.show).not.toHaveBeenCalled()
    useAppStore.setState({ pendingWorktreeCreations: {} })
    expect(lastText()).toBe('Claude isn’t set up for Orca Cloud, so it didn’t start.')
    // Away from it, the toast names the real workspace, not the empty field.
    useAppStore.setState({ activeWorktreeId: 'chinook-id' })
    useAppStore.setState({ activeWorktreeId: 'other' })
    expect(lastText()).toBe('Claude isn’t set up for Orca Cloud, so it didn’t start in chinook.')
  })
})

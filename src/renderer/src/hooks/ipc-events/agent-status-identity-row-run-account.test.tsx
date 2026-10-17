// @vitest-environment happy-dom
// A kept agent whose terminal died while Orca was closed reaches this renderer as its restored row,
// then the host's pane clear, then the identity row the host kept — facet included. Its refused
// resume says "un-keep it from the tab menu", so that menu must still offer it after the clear.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { useIdentityRowRunAccounts } from '@/store/agent-identity-row-run-accounts'
import { TabAgentAccountMenuItems } from '@/components/tab-bar/TabAgentAccountMenuItems'
import { getDefaultSettings } from '../../../../shared/constants'
import type { AgentRunAccount } from '../../../../shared/agent-run-account'
import type {
  AgentStatusClearIpcPayload,
  AgentStatusIpcPayload
} from '../../../../shared/agent-status-types'
import type { CodexManagedAccount } from '../../../../shared/managed-account-types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { registerAgentStatusIpcBridge, type AgentStatusIpcBridge } from './agent-status-ipc-bridge'

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuCheckboxItem: ({
    children,
    checked,
    onCheckedChange
  }: {
    children?: ReactNode
    checked?: boolean
    onCheckedChange?: (checked: boolean) => void
  }) => (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      onClick={() => onCheckedChange?.(!checked)}
    >
      {children}
    </button>
  )
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/lib/codex-session-restart', () => ({
  markRestoredStaleCodexSessionsForRestart: vi.fn(async () => [])
}))
vi.mock('../agent-hook-completion-notifications', () => ({
  observeAgentHookCompletionForNotification: vi.fn(),
  syncAgentHookCompletionNotificationsForStoreUpdate: vi.fn()
}))

const TAB = 'tab-1'
const LEAF = '11111111-1111-4111-8111-111111111111'
const PANE = makePaneKey(TAB, LEAF)
const WORKTREE = 'repo-1::/wt-1'
const STARTED = 1_700_000_000_000
const KEPT: AgentRunAccount = { provider: 'codex', lane: 'host', accountId: 'work', mode: 'kept' }

function codexAccount(id: string): CodexManagedAccount {
  return {
    id,
    email: `${id}@example.com`,
    managedHomePath: '/unused',
    createdAt: 0,
    updatedAt: 0,
    lastAuthenticatedAt: 0
  }
}

function hostRow(overrides: Partial<AgentStatusIpcPayload> = {}): AgentStatusIpcPayload {
  return {
    paneKey: PANE,
    tabId: TAB,
    worktreeId: WORKTREE,
    connectionId: null,
    receivedAt: STARTED,
    stateStartedAt: STARTED,
    state: 'working',
    prompt: 'review the PR',
    agentType: 'codex',
    providerSession: { key: 'session_id', id: 'resume-1' },
    ...overrides
  }
}

const setKept = vi.fn()
let onSetListener: (data: AgentStatusIpcPayload) => void = () => {}
let onClear: (data: AgentStatusClearIpcPayload) => void = () => {}
let snapshot: AgentStatusIpcPayload[] = []
let bridge: AgentStatusIpcBridge | null = null
const unsubs: (() => void)[] = []

/** Delivers one host row and lets the bridge's live burst window flush it. */
async function onSet(data: AgentStatusIpcPayload): Promise<void> {
  await act(async () => {
    onSetListener(data)
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
}

function startBridge(): void {
  bridge = registerAgentStatusIpcBridge(unsubs)
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  useIdentityRowRunAccounts.setState({ byPaneKey: {} }, true)
  useAppStore.setState({
    workspaceSessionReady: true,
    settings: {
      ...getDefaultSettings('/home/user'),
      codexManagedAccounts: [codexAccount('work'), codexAccount('personal')],
      activeCodexManagedAccountId: 'personal'
    },
    tabsByWorktree: {
      [WORKTREE]: [
        {
          id: TAB,
          ptyId: 'pty-1',
          worktreeId: WORKTREE,
          title: 'Codex',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 0
        }
      ]
    },
    terminalLayoutsByTabId: {
      [TAB]: {
        root: { type: 'leaf', leafId: LEAF },
        activeLeafId: LEAF,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF]: 'pty-1' }
      }
    }
  })
  setKept.mockReset()
  snapshot = []
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      agentAccounts: { setKept },
      agentStatus: {
        onSet: (callback: typeof onSetListener) => {
          onSetListener = callback
          return () => {}
        },
        onClear: (callback: typeof onClear) => {
          onClear = callback
          return () => {}
        },
        getSnapshot: async () => snapshot
      }
    }
  })
})

afterEach(() => {
  bridge?.disposeAsyncState()
  bridge?.unsubscribeStore()
  bridge = null
  unsubs.splice(0).forEach((unsubscribe) => unsubscribe())
  cleanup()
  useAppStore.setState(useAppStore.getInitialState(), true)
  useIdentityRowRunAccounts.setState({ byPaneKey: {} }, true)
})

function keepItems(): [string | null, string | null][] {
  return screen
    .queryAllByRole('menuitemcheckbox')
    .map((item) => [item.textContent, item.getAttribute('aria-checked')])
}

describe('a kept agent retired to its identity row', () => {
  it('stays un-keepable from the tab menu after the host clears its restored row', async () => {
    startBridge()
    render(<TabAgentAccountMenuItems tabId={TAB} />)
    await onSet(hostRow({ restoredUnconfirmed: true, runAccount: KEPT }))
    expect(keepItems()).toEqual([['Keep on work@example.com', 'true']])

    // The dead-terminal sweep: the pane stops claiming work, then the identity row is restated.
    act(() => onClear({ paneKey: PANE }))
    await onSet(hostRow({ providerSessionOnly: true, runAccount: KEPT }))

    expect(useAppStore.getState().agentStatusByPaneKey[PANE]).toBeUndefined()
    expect(keepItems()).toEqual([['Keep on work@example.com', 'true']])

    fireEvent.click(screen.getByRole('menuitemcheckbox'))
    expect(setKept).toHaveBeenCalledWith({ paneKey: PANE, ptyId: 'pty-1', kept: false })

    // The host withdraws a facet nothing observes any more once it is released.
    await onSet(hostRow({ providerSessionOnly: true, runAccount: null }))
    expect(keepItems()).toEqual([])
  })

  it('reads the facet from the startup snapshot of a window opened after the sweep', async () => {
    snapshot = [hostRow({ providerSessionOnly: true, runAccount: KEPT })]
    startBridge()
    render(<TabAgentAccountMenuItems tabId={TAB} />)

    await vi.waitFor(() => expect(keepItems()).toEqual([['Keep on work@example.com', 'true']]))
    expect(useAppStore.getState().agentStatusByPaneKey[PANE]).toBeUndefined()
  })

  it('follows the host past a completed row the clear leaves in place', async () => {
    startBridge()
    render(<TabAgentAccountMenuItems tabId={TAB} />)
    await onSet(hostRow({ state: 'done', runAccount: KEPT }))
    act(() => onClear({ paneKey: PANE }))
    await onSet(hostRow({ state: 'done', providerSessionOnly: true, runAccount: KEPT }))
    expect(useAppStore.getState().agentStatusByPaneKey[PANE]?.runAccount).toEqual(KEPT)

    await onSet(hostRow({ state: 'done', providerSessionOnly: true, runAccount: null }))

    // The completed row still says kept; the host's identity row no longer does.
    expect(keepItems()).toEqual([])
  })

  it('forgets the facet when the host clears the pane for good', async () => {
    startBridge()
    render(<TabAgentAccountMenuItems tabId={TAB} />)
    await onSet(hostRow({ providerSessionOnly: true, runAccount: KEPT }))
    expect(keepItems()).toEqual([['Keep on work@example.com', 'true']])

    act(() => onClear({ paneKey: PANE }))

    expect(keepItems()).toEqual([])
  })

  it("gives the pane back to the resumed agent's own row", async () => {
    startBridge()
    render(<TabAgentAccountMenuItems tabId={TAB} />)
    await onSet(hostRow({ providerSessionOnly: true, runAccount: KEPT }))
    expect(keepItems()).toEqual([['Keep on work@example.com', 'true']])

    const follow: AgentRunAccount = { ...KEPT, accountId: 'personal', mode: 'follow' }
    await onSet(hostRow({ receivedAt: STARTED + 1, runAccount: follow }))

    expect(useIdentityRowRunAccounts.getState().byPaneKey).toEqual({})
    expect(keepItems()).toEqual([['Keep on personal@example.com', 'false']])
  })

  it('never names an account from a remote identity row, nor a stale one', async () => {
    startBridge()
    render(<TabAgentAccountMenuItems tabId={TAB} />)
    await onSet(hostRow({ providerSessionOnly: true, runAccount: KEPT }))
    await onSet(hostRow({ receivedAt: STARTED - 1, providerSessionOnly: true, runAccount: null }))
    expect(keepItems()).toEqual([['Keep on work@example.com', 'true']])

    await onSet(
      hostRow({
        receivedAt: STARTED + 1,
        connectionId: 'ssh-1',
        providerSessionOnly: true,
        runAccount: KEPT
      })
    )
    expect(keepItems()).toEqual([])
  })
})

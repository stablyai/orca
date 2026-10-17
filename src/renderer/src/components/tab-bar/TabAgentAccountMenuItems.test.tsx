// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { useAppStore } from '../../store'
import { getDefaultSettings } from '../../../../shared/constants'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { AgentRunAccount } from '../../../../shared/agent-run-account'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { CodexManagedAccount } from '../../../../shared/managed-account-types'
import { markRestoredStaleCodexSessionsForRestart } from '@/lib/codex-session-restart'
import { TabAgentAccountMenuItems } from './TabAgentAccountMenuItems'

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuCheckboxItem: ({
    children,
    checked,
    disabled,
    onCheckedChange
  }: {
    children?: ReactNode
    checked?: boolean
    disabled?: boolean
    onCheckedChange?: (checked: boolean) => void
  }) => (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      disabled={disabled}
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

const TAB = 'tab-1'
const LEFT = '11111111-1111-4111-8111-111111111111'
const RIGHT = '22222222-2222-4222-8222-222222222222'

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

function row(leafId: string, runAccount: AgentRunAccount): [string, AgentStatusEntry] {
  const paneKey = makePaneKey(TAB, leafId)
  return [
    paneKey,
    {
      state: 'working',
      prompt: '',
      updatedAt: 1,
      stateStartedAt: 1,
      paneKey,
      stateHistory: [],
      connectionId: null,
      runAccount
    }
  ]
}

const setKept = vi.fn()

function seed(rows: [string, AgentStatusEntry][]): void {
  const leafIds = rows.map(([paneKey]) => paneKey.slice(TAB.length + 1))
  useAppStore.setState({
    settings: {
      ...getDefaultSettings('/home/user'),
      codexManagedAccounts: [codexAccount('work'), codexAccount('personal')],
      activeCodexManagedAccountId: 'work'
    },
    terminalLayoutsByTabId: {
      [TAB]: {
        root:
          leafIds.length === 1
            ? { type: 'leaf', leafId: leafIds[0]! }
            : {
                type: 'split',
                direction: 'vertical',
                first: { type: 'leaf', leafId: leafIds[0]! },
                second: { type: 'leaf', leafId: leafIds[1]! }
              },
        activeLeafId: leafIds[0]!,
        expandedLeafId: null,
        ptyIdsByLeafId: Object.fromEntries(leafIds.map((leafId) => [leafId, `pty-${leafId}`]))
      }
    },
    agentStatusByPaneKey: Object.fromEntries(rows)
  })
}

const CODEX = { provider: 'codex', lane: 'host' } as const

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  setKept.mockReset()
  vi.mocked(toast.error).mockReset()
  vi.mocked(markRestoredStaleCodexSessionsForRestart).mockClear()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { agentAccounts: { setKept } }
  })
})

afterEach(() => {
  cleanup()
  useAppStore.setState(useAppStore.getInitialState(), true)
})

describe('Keep on <account> in the tab menu', () => {
  it('offers one checkbox per agent pane, checked when kept', () => {
    seed([
      row(LEFT, { ...CODEX, accountId: 'work', mode: 'kept' }),
      row(RIGHT, { ...CODEX, accountId: 'personal', mode: 'follow' })
    ])
    render(<TabAgentAccountMenuItems tabId={TAB} />)

    const items = screen.getAllByRole('menuitemcheckbox')
    expect(items.map((item) => [item.textContent, item.getAttribute('aria-checked')])).toEqual([
      ['Keep Codex 1 on work@example.com', 'true'],
      ['Keep Codex 2 on personal@example.com', 'false']
    ])
  })

  it('renders nothing for a tab with no published account', () => {
    const { container } = render(<TabAgentAccountMenuItems tabId={TAB} />)
    expect(container.innerHTML).toBe('')
  })

  it.each([
    ['no-session', 'Available once the agent reports its session'],
    ['codex-home-not-keepable', 'Not available while CODEX_HOME is set']
  ] as const)('explains why Keep is off: %s', (keepUnavailable, reason) => {
    seed([row(LEFT, { ...CODEX, accountId: 'work', mode: 'follow', keepUnavailable })])
    render(<TabAgentAccountMenuItems tabId={TAB} />)
    const item = screen.getByRole('menuitemcheckbox')
    expect(item.textContent).toContain(reason)
    expect(item).toHaveProperty('disabled', true)
  })

  it('keeps the pane through the host and disables the item until it answers', async () => {
    let answer: (value: unknown) => void = () => {}
    setKept.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    seed([row(LEFT, { ...CODEX, accountId: 'work', mode: 'follow' })])
    render(<TabAgentAccountMenuItems tabId={TAB} />)

    fireEvent.click(screen.getByRole('menuitemcheckbox'))

    expect(setKept).toHaveBeenCalledWith({
      paneKey: makePaneKey(TAB, LEFT),
      ptyId: `pty-${LEFT}`,
      kept: true
    })
    expect(screen.getByRole('menuitemcheckbox')).toHaveProperty('disabled', true)
    await act(async () =>
      answer({ ok: true, runAccount: { ...CODEX, accountId: 'work', mode: 'kept' } })
    )
    expect(screen.getByRole('menuitemcheckbox')).toHaveProperty('disabled', false)
    expect(markRestoredStaleCodexSessionsForRestart).not.toHaveBeenCalled()
  })

  it("re-checks a released Codex pane against the selection, so it gets today's prompt", async () => {
    setKept.mockResolvedValue({
      ok: true,
      runAccount: { ...CODEX, accountId: 'personal', mode: 'follow' }
    })
    seed([row(LEFT, { ...CODEX, accountId: 'personal', mode: 'kept' })])
    render(<TabAgentAccountMenuItems tabId={TAB} />)

    await act(async () => {
      fireEvent.click(screen.getByRole('menuitemcheckbox'))
    })

    expect(setKept).toHaveBeenCalledWith(expect.objectContaining({ kept: false }))
    expect(markRestoredStaleCodexSessionsForRestart).toHaveBeenCalledWith({
      ptyIds: [`pty-${LEFT}`]
    })
  })

  it("answers a Codex pane's account-switched prompt once the pane is kept", async () => {
    setKept.mockResolvedValue({
      ok: true,
      runAccount: { ...CODEX, accountId: 'work', mode: 'kept' }
    })
    seed([row(LEFT, { ...CODEX, accountId: 'work', mode: 'follow' })])
    useAppStore
      .getState()
      .markCodexRestartNotices([
        { ptyId: `pty-${LEFT}`, previousAccountLabel: 'work', nextAccountLabel: 'personal' }
      ])
    render(<TabAgentAccountMenuItems tabId={TAB} />)

    await act(async () => {
      fireEvent.click(screen.getByRole('menuitemcheckbox'))
    })

    expect(useAppStore.getState().codexRestartNoticeByPtyId[`pty-${LEFT}`]?.dismissed).toBe(true)
  })

  it('says why the host refused', async () => {
    setKept.mockResolvedValue({ ok: false, reason: 'unavailable' })
    seed([row(LEFT, { ...CODEX, accountId: 'work', mode: 'follow' })])
    render(<TabAgentAccountMenuItems tabId={TAB} />)

    await act(async () => {
      fireEvent.click(screen.getByRole('menuitemcheckbox'))
    })

    expect(toast.error).toHaveBeenCalledWith(
      'Orca could not save this right now. Try again in a moment.'
    )
  })
})

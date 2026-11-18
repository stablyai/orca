// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { ProviderAccountChatButton } from '@/components/status-bar/accounts/ProviderAccountChatButton'
import { TranslationScopeProvider } from '@/i18n/translation-scope-provider'
import { useAppStore } from '@/store/index'
import { NativeChatNoticeRow } from '@/components/native-chat/messages/notices/NativeChatNoticeRow'
import {
  NativeChatOrcaStopContext,
  type NativeChatOrcaStopView
} from '@/components/native-chat/messages/notices/native-chat-orca-stop-context'
import {
  UsageLimitActionsContext,
  type UsageLimitActions
} from '@/components/native-chat/usage/NativeChatUsageLimitActions'
import type { NativeChatUsageLimitAutoContinueState } from '@/components/native-chat/usage/native-chat-usage-limit-auto-continue-setting'
import type { NativeChatTextBlock } from '../../../../../shared/native-chat/native-chat-types'

const toastError = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { error: toastError, success: vi.fn() } }))

const HOUR = 60 * 60 * 1000
const start = new Date(2026, 9, 18, 12).getTime()

function limitBlock(
  resetsAt: number | undefined,
  extra: Partial<NativeChatTextBlock> = {}
): NativeChatTextBlock {
  return {
    type: 'text',
    tone: 'warning',
    text: 'Codex hit its usage limit.',
    usageLimitTurnItemId: 'cut-turn',
    failure: { kind: 'usageLimitReached', usageLimit: { window: 'session', resetsAt } },
    ...extra
  }
}

function stopView(
  active: boolean,
  auto: NativeChatUsageLimitAutoContinueState | null,
  continueUsageLimit: (hadFocus?: boolean) => void,
  autoUnavailable = false,
  host: { remote?: boolean; continueAt?: number } = {}
): NativeChatOrcaStopView {
  return {
    hostLabel: null,
    remoteHost: host.remote === true,
    ...(host.continueAt === undefined ? {} : { usageLimitContinueAt: host.continueAt }),
    continueAvailable: false,
    offeredTurnItemId: null,
    continueNow: () => {},
    usageLimitTurnItemId: active ? 'cut-turn' : null,
    usageLimitAutoContinue: auto,
    usageLimitAutoContinueUnavailable: autoUnavailable,
    continueUsageLimit
  }
}

function row({
  resetsAt,
  active = true,
  auto = null,
  actions = null,
  block,
  continueUsageLimit = () => {},
  remote = false,
  continueAt
}: {
  resetsAt?: number
  active?: boolean
  auto?: NativeChatUsageLimitAutoContinueState | null
  actions?: UsageLimitActions | null
  block?: NativeChatTextBlock
  continueUsageLimit?: (hadFocus?: boolean) => void
  /** The chat runs on a paired server, not this machine. */
  remote?: boolean
  /** When the host lets Continue apply, e.g. earlier after an account switch. */
  continueAt?: number
}) {
  const view = stopView(active, auto, continueUsageLimit, false, { remote, continueAt })
  return (
    <TranslationScopeProvider>
      <TooltipProvider>
        <NativeChatOrcaStopContext.Provider value={view}>
          <UsageLimitActionsContext.Provider value={actions}>
            <input aria-label="composer" />
            <NativeChatNoticeRow agentName="Codex" block={block ?? limitBlock(resetsAt)} />
          </UsageLimitActionsContext.Provider>
        </NativeChatOrcaStopContext.Provider>
      </TooltipProvider>
    </TranslationScopeProvider>
  )
}

const handOffActions = (handOff = vi.fn()): UsageLimitActions => ({
  account: null,
  handOff,
  disabled: false,
  preparing: false
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  toastError.mockReset()
})

describe('usage-limit row over time', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: start, toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  })

  it('offers Continue only once the effective time passes, and keeps a later schedule cancellable', () => {
    const cancel = vi.fn()
    const auto = { kind: 'scheduled', resetsAt: start + 3 * HOUR, cancel } as const
    render(row({ resetsAt: start + HOUR, auto, actions: handOffActions() }))
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull()
    const clock = screen.getByRole('button', { pressed: true })
    fireEvent.click(clock)
    expect(cancel).toHaveBeenCalledTimes(1)

    act(() => vi.advanceTimersByTime(HOUR))
    expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { pressed: true })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Hand off to another agent' })).toBeNull()
  })

  it('never turns an older turn into a ready row, however long it waits', () => {
    render(row({ resetsAt: start + HOUR, active: false, actions: handOffActions() }))
    act(() => vi.advanceTimersByTime(2 * HOUR))
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Hand off to another agent' })).toBeNull()
    expect(screen.getByRole('button', { name: 'More actions' })).toBeInTheDocument()
  })

  it('moves focus from a tool that disappears at the reset to Continue', () => {
    render(row({ resetsAt: start + HOUR, actions: handOffActions() }))
    screen.getByRole('button', { name: 'Hand off to another agent' }).focus()
    act(() => vi.advanceTimersByTime(HOUR))
    expect(screen.getByRole('button', { name: 'Continue' })).toHaveFocus()
  })

  it('leaves focus elsewhere alone when the reset swaps the tools', () => {
    render(row({ resetsAt: start + HOUR, actions: handOffActions() }))
    screen.getByRole('textbox', { name: 'composer' }).focus()
    act(() => vi.advanceTimersByTime(HOUR))
    expect(screen.getByRole('textbox', { name: 'composer' })).toHaveFocus()
  })

  it('moves focus from an open account menu that disappears at the reset to Continue', () => {
    const account = (
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <ProviderAccountChatButton
            provider="claude"
            target={{ kind: 'local' }}
            disabled={false}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Other account</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    )
    render(row({ resetsAt: start + HOUR, actions: { ...handOffActions(), account } }))
    const trigger = screen.getByRole('button', { name: 'Switch account' })
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'Enter' })
    const item = screen.getByRole('menuitem', { name: 'Other account' })
    act(() => item.focus())
    expect(item).toHaveFocus()
    // Jump the wall clock and let the row's focus refresh notice it, as after sleep.
    vi.setSystemTime(start + HOUR)
    act(() => {
      fireEvent(window, new Event('focus'))
    })
    expect(screen.queryByRole('menuitem', { name: 'Other account' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Continue' })).toHaveFocus()
  })

  it('cancels a later schedule from More once the chat is ready', () => {
    const cancel = vi.fn()
    const auto = { kind: 'scheduled', resetsAt: start + 3 * HOUR, cancel } as const
    const view = render(row({ resetsAt: start + HOUR, auto }))
    vi.setSystemTime(start + HOUR)
    act(() => {
      fireEvent(window, new Event('focus'))
    })
    fireEvent.keyDown(screen.getByRole('button', { name: 'More actions' }), { key: 'Enter' })
    fireEvent.click(screen.getByRole('menuitem', { name: /^Don't continue at / }))
    expect(cancel).toHaveBeenCalledTimes(1)

    // While a cancel is in flight the item can't be chosen again.
    view.rerender(row({ resetsAt: start + HOUR, auto: { ...auto, cancelDisabled: true } }))
    fireEvent.keyDown(screen.getByRole('button', { name: 'More actions' }), { key: 'Enter' })
    expect(screen.getByRole('menuitem', { name: /^Don't continue at / })).toHaveAttribute(
      'aria-disabled',
      'true'
    )
  })

  it('claims usage only once the provider reset passes, not when an earlier Continue applies', () => {
    const at = (when: number) => {
      vi.setSystemTime(when)
      act(() => {
        fireEvent(window, new Event('focus'))
      })
    }
    // An account switch lets Continue apply at 1h, while the provider still resets at 3h.
    render(row({ resetsAt: start + 3 * HOUR, continueAt: start + HOUR }))
    at(start + HOUR)
    expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument()
    expect(screen.queryByText(/has usage again/)).toBeNull()
    expect(screen.getByText('Codex can continue now')).toBeInTheDocument()
    at(start + 3 * HOUR)
    expect(screen.getByText('Codex has usage again')).toBeInTheDocument()
    expect(screen.queryByText(/can continue now/)).toBeNull()
  })

  it("never opens this machine's setting for a remote chat; it offers only a published schedule", () => {
    const remoteClock = (auto: NativeChatUsageLimitAutoContinueState | null) => {
      const view = render(row({ resetsAt: start + HOUR, auto, remote: true }))
      const pressed = screen.queryByRole('button', { pressed: true })
      const settings = screen.queryByRole('button', { name: 'Auto-continue settings' })
      const wont = screen.queryByRole('button', { name: "Won't continue automatically" })
      fireEvent.keyDown(screen.getByRole('button', { name: 'More actions' }), { key: 'Enter' })
      const menuSetting = screen.queryByRole('menuitem', { name: 'Auto-continue settings…' })
      view.unmount()
      return { pressed, settings, wont, menuSetting }
    }
    // Loading or unpublished: nothing to show.
    expect(remoteClock(null)).toEqual({
      pressed: null,
      settings: null,
      wont: null,
      menuSetting: null
    })
    expect(remoteClock({ kind: 'cancelled' }).wont).toBeNull()
    expect(remoteClock({ kind: 'cancelled' }).menuSetting).toBeNull()
    const cancel = vi.fn()
    const scheduled = remoteClock({ kind: 'scheduled', resetsAt: start + HOUR, cancel })
    expect(scheduled.pressed).not.toBeNull()
    expect(scheduled.menuSetting).toBeNull()
  })

  it('offers no auto-continue control where this machine has no say', () => {
    // A host without the feature, or a remote host whose own setting is off, both arrive as this.
    const view = stopView(true, null, () => {}, true)
    render(
      <TranslationScopeProvider>
        <TooltipProvider>
          <NativeChatOrcaStopContext.Provider value={view}>
            <NativeChatNoticeRow agentName="Codex" block={limitBlock(start + HOUR)} />
          </NativeChatOrcaStopContext.Provider>
        </TooltipProvider>
      </TranslationScopeProvider>
    )
    expect(screen.queryByRole('button', { name: 'Auto-continue settings' })).toBeNull()
    fireEvent.keyDown(screen.getByRole('button', { name: 'More actions' }), { key: 'Enter' })
    expect(screen.getByRole('menuitem', { name: 'Copy error' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Auto-continue settings…' })).toBeNull()
  })

  it('turns auto-continue on in place while waiting, even with no published state', () => {
    const openSettingsPage = vi.fn()
    const updateSettings = vi.fn(async () => {})
    useAppStore.setState({ openSettingsPage, openSettingsTarget: vi.fn(), updateSettings })
    const view = render(row({ resetsAt: start + HOUR, auto: null }))
    fireEvent.click(
      screen.getByRole('button', { name: 'Continue automatically when limits reset' })
    )
    expect(updateSettings).toHaveBeenCalledWith({ nativeChatAutoContinueAfterUsageLimit: true })
    expect(openSettingsPage).not.toHaveBeenCalled()
    // Nothing to schedule against without a reset time.
    view.rerender(row({ resetsAt: undefined, auto: null }))
    expect(
      screen.queryByRole('button', { name: 'Continue automatically when limits reset' })
    ).toBeNull()
  })

  it('opens Settings when the host reports off while the setting is already on', () => {
    const openSettingsPage = vi.fn()
    useAppStore.setState({
      openSettingsPage,
      openSettingsTarget: vi.fn(),
      settings: { ...useAppStore.getState().settings!, nativeChatAutoContinueAfterUsageLimit: true }
    })
    render(row({ resetsAt: start + HOUR, auto: { kind: 'off' } }))
    fireEvent.click(screen.getByRole('button', { name: 'Auto-continue settings' }))
    expect(openSettingsPage).toHaveBeenCalledTimes(1)
  })

  it('keeps a preparing Hand off focusable but inert', () => {
    const handOff = vi.fn()
    render(
      row({
        resetsAt: start + HOUR,
        actions: { ...handOffActions(handOff), disabled: true, preparing: true }
      })
    )
    const button = screen.getByRole('button', { name: 'Hand off to another agent' })
    button.focus()
    fireEvent.click(button)
    expect(button).toHaveFocus()
    expect(handOff).not.toHaveBeenCalled()
  })
})

describe('usage-limit row More menu', () => {
  const frame = {
    provider: 'codex',
    kind: 'notification:error',
    payload: {
      head: '{"error":"PAYLOAD_SENTINEL"}',
      byteLength: 9999,
      digest: 'd',
      truncated: true
    }
  }
  let writeClipboardText: ReturnType<typeof vi.fn>

  beforeEach(() => {
    writeClipboardText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { ui: { writeClipboardText } }
    })
  })

  it('shows details on demand and returns focus to More when they collapse', async () => {
    const user = userEvent.setup()
    render(
      row({
        resetsAt: Date.now() + HOUR,
        block: limitBlock(Date.now() + HOUR, { providerFrame: frame })
      })
    )
    expect(screen.queryByText(/PAYLOAD_SENTINEL/)).toBeNull()
    await user.click(screen.getByRole('button', { name: 'More actions' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Show details' }))
    expect(screen.getByText(/PAYLOAD_SENTINEL/)).toBeVisible()

    const summary = screen.getByText('Details').closest('summary')!
    summary.focus()
    await act(async () => {
      const details = summary.closest('details')!
      details.open = false
      details.dispatchEvent(new Event('toggle'))
    })
    expect(screen.queryByText(/PAYLOAD_SENTINEL/)).toBeNull()
    expect(screen.getByRole('button', { name: 'More actions' })).toHaveFocus()
  })

  it('copies the sentence with the frame identity, payload and truncation', async () => {
    const user = userEvent.setup()
    render(
      row({
        resetsAt: Date.now() + HOUR,
        block: limitBlock(Date.now() + HOUR, { providerFrame: frame })
      })
    )
    await user.click(screen.getByRole('button', { name: 'More actions' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Copy error' }))
    for (const part of ['codex · notification:error', 'PAYLOAD_SENTINEL', '9999']) {
      expect(writeClipboardText).toHaveBeenCalledWith(expect.stringContaining(part))
    }
    expect(toastError).not.toHaveBeenCalled()
  })
})

import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { NativeChatTextBlock } from '../../../../../shared/native-chat/native-chat-types'
import type { AgentSessionUsageLimitWindow } from '../../../../../shared/agent-session/failures/agent-session-usage-limit'
import { ProviderAccountChatButton } from '@/components/status-bar/accounts/ProviderAccountChatButton'
import {
  NativeChatOrcaStopContext,
  type NativeChatOrcaStopView
} from '../messages/notices/native-chat-orca-stop-context'
import { NativeChatNoticeRow } from '../messages/notices/NativeChatNoticeRow'
import { UsageLimitActionsContext, type UsageLimitActions } from './NativeChatUsageLimitActions'
import type { NativeChatUsageLimitAutoContinueState } from './native-chat-usage-limit-auto-continue-setting'

const MINUTE = 60_000
// Half a minute past each whole minute, so a countdown label never sits on a flip while rendering.
const OFFSET = 30_000
const PANE_WIDTHS = [220, 320, 600] as const

type State = {
  agent: 'Codex' | 'Claude' | 'Antigravity'
  window?: AgentSessionUsageLimitWindow
  /** Minutes until the provider's reset; undefined for an unknown reset. */
  resetIn?: number
  /** Minutes until Orca's own continue, when it differs from the reset. */
  autoIn?: number
  auto?: 'off' | 'scheduled' | 'cancelled'
  account?: 'switch' | 'loading'
  handOff?: 'ready' | 'preparing' | 'none'
  frame?: boolean
  /** The account a switch moved the chat to, itself out of quota for this many minutes. */
  limitedAccount?: { email: string; resetIn: number }
}

function block(state: State, now: number): NativeChatTextBlock {
  const resetsAt = state.resetIn === undefined ? undefined : now + state.resetIn * MINUTE + OFFSET
  return {
    type: 'text',
    tone: 'warning',
    text: `${state.agent} hit its usage limit.`,
    usageLimitTurnItemId: 'cut-turn',
    failure: {
      kind: 'usageLimitReached',
      // A provider that names neither leaves the limit out entirely.
      ...(state.window || resetsAt !== undefined
        ? {
            usageLimit: {
              ...(state.window ? { window: state.window } : {}),
              ...(resetsAt !== undefined ? { resetsAt } : {})
            }
          }
        : {})
    },
    ...(state.frame
      ? {
          providerFrame: {
            provider: state.agent.toLowerCase(),
            kind: 'notification:error',
            payload: {
              head: '{"error":{"type":"usage_limit_reached","resets_in_seconds":8040}}',
              byteLength: 66,
              digest: 'fixture',
              truncated: false
            }
          }
        }
      : {})
  }
}

function autoState(state: State, now: number): NativeChatUsageLimitAutoContinueState | null {
  if (!state.auto || state.resetIn === undefined) {
    return null
  }
  return state.auto === 'scheduled'
    ? {
        kind: 'scheduled',
        resetsAt: now + (state.autoIn ?? state.resetIn) * MINUTE + OFFSET,
        cancel: () => {}
      }
    : { kind: state.auto }
}

function UsageLimitPanes({
  state,
  active,
  widths
}: {
  state: State
  active: boolean
  widths: readonly number[]
}): ReactNode {
  const [now] = useState(Date.now)
  const view = useMemo<NativeChatOrcaStopView>(
    () => ({
      hostLabel: null,
      remoteHost: false,
      continueAvailable: false,
      offeredTurnItemId: null,
      continueNow: () => {},
      usageLimitTurnItemId: active ? 'cut-turn' : null,
      usageLimitAutoContinue: autoState(state, now),
      ...(state.limitedAccount
        ? {
            usageLimitLimitedAccount: state.limitedAccount.email,
            usageLimitContinueAt: now + state.limitedAccount.resetIn * MINUTE + OFFSET
          }
        : {}),
      continueUsageLimit: () => {}
    }),
    [active, state, now]
  )
  const actions = useMemo<UsageLimitActions>(
    () => ({
      account:
        state.account === undefined ? null : (
          <ProviderAccountChatButton
            provider={state.agent === 'Antigravity' ? 'antigravity' : 'claude'}
            target={{ kind: 'local' }}
            disabled={state.account === 'loading'}
            busy={state.account === 'loading'}
          />
        ),
      disabled: state.handOff === 'preparing' || state.account === 'loading',
      preparing: state.handOff === 'preparing',
      ...(state.handOff === 'none' ? {} : { handOff: () => {} })
    }),
    [state]
  )
  return (
    <NativeChatOrcaStopContext.Provider value={view}>
      <UsageLimitActionsContext.Provider value={actions}>
        <div className="native-chat-appearance flex flex-col gap-4 p-3">
          {widths.map((width) => (
            <div
              key={width}
              style={{ width }}
              className="border border-dashed border-border px-3 py-2"
            >
              <div className="mb-1 text-2xs text-muted-foreground">{width}px pane</div>
              <NativeChatNoticeRow agentName={state.agent} block={block(state, now)} />
            </div>
          ))}
        </div>
      </UsageLimitActionsContext.Provider>
    </NativeChatOrcaStopContext.Provider>
  )
}

const fixture = (
  state: State,
  {
    active = true,
    widths = PANE_WIDTHS,
    interact
  }: {
    active?: boolean
    widths?: readonly number[]
    interact?: (frame: HTMLElement) => void | Promise<void>
  } = {}
) =>
  defineFixture({
    width: Math.max(...widths) + 40,
    render: () => <UsageLimitPanes state={state} active={active} widths={widths} />,
    interact
  })

export const codexSession = fixture({
  agent: 'Codex',
  window: 'session',
  resetIn: 134,
  frame: true
})
export const claudeSwitch = fixture({
  agent: 'Claude',
  window: 'session',
  resetIn: 134,
  account: 'switch'
})
export const claudeAccountLoading = fixture({
  agent: 'Claude',
  window: 'session',
  resetIn: 134,
  account: 'loading'
})
export const weekly = fixture({ agent: 'Codex', window: 'weekly', resetIn: 2 * 24 * 60 + 90 })
export const noResetTime = fixture({ agent: 'Codex' })
export const autoOff = fixture({ agent: 'Codex', window: 'session', resetIn: 134, auto: 'off' })
export const autoScheduled = fixture({
  agent: 'Claude',
  window: 'session',
  resetIn: 134,
  auto: 'scheduled',
  account: 'switch'
})
export const autoScheduledLater = fixture({
  agent: 'Codex',
  window: 'session',
  resetIn: 134,
  autoIn: 254,
  auto: 'scheduled'
})
export const autoCancelled = fixture({
  agent: 'Codex',
  window: 'session',
  resetIn: 134,
  auto: 'cancelled'
})
export const resetPassed = fixture({ agent: 'Codex', window: 'session', resetIn: -1, frame: true })
export const readyAutoPending = fixture({
  agent: 'Codex',
  window: 'session',
  resetIn: -1,
  autoIn: 120,
  auto: 'scheduled'
})
export const handOffPreparing = fixture({
  agent: 'Codex',
  window: 'session',
  resetIn: 134,
  handOff: 'preparing'
})
export const extraUsageAllTools = fixture({
  agent: 'Claude',
  window: 'credits',
  resetIn: 134,
  auto: 'off',
  account: 'switch',
  frame: true
})
export const historical = fixture(
  { agent: 'Codex', window: 'weeklyModel', resetIn: 30, frame: true },
  { active: false }
)
// The narrowest and widest panes the row must hold, with every tool showing.
export const allToolsExtremes = fixture(
  { agent: 'Claude', window: 'weeklyModel', resetIn: 134, auto: 'scheduled', account: 'switch' },
  { widths: [200, 800] }
)

// Opens More, then "Show details", in each pane. Synthetic clicks read as keyboard input, so the
// restored focus is dropped to keep the shot free of a keyboard focus ring.
export const detailsExpanded = fixture(
  { agent: 'Codex', window: 'session', resetIn: 134, frame: true },
  {
    interact: async (frame) => {
      for (const trigger of frame.querySelectorAll<HTMLButtonElement>(
        'button[aria-label="More actions"]'
      )) {
        trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
        await new Promise((resolve) => setTimeout(resolve, 50))
        document.querySelector<HTMLElement>('[role="menuitem"]')?.click()
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      const focused = document.activeElement
      if (focused instanceof HTMLElement) {
        focused.blur()
      }
    }
  }
)

// A switch moved the chat to an account that is itself out of quota: it waits for that account.
export const antigravityAccountOutOfQuota = fixture({
  agent: 'Antigravity',
  window: 'session',
  resetIn: 40,
  account: 'switch',
  limitedAccount: { email: 'personal@example.com', resetIn: 190 }
})

// The same, when the saved account it moved to has no email.
export const antigravityUnnamedAccountOutOfQuota = fixture({
  agent: 'Antigravity',
  window: 'session',
  resetIn: 40,
  account: 'switch',
  limitedAccount: { email: '', resetIn: 190 }
})

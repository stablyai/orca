import { createContext, useContext, useMemo, useRef, useLayoutEffect, type ReactNode } from 'react'
import { MessageSquarePlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { ClaudeSwitcherMenu } from '@/components/status-bar/ClaudeSwitcherMenu'
import { ProviderAccountChatButton } from '@/components/status-bar/ProviderAccountChatButton'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import type { AgentSessionOptionsResult } from '../../../../shared/agent-session-wire'
import { executionHostIdForStructuredTarget } from '@/runtime/structured-agent-session-owner'
import {
  NativeChatOrcaStopContext,
  type NativeChatOrcaStopView
} from './native-chat-orca-stop-context'
import type { NativeChatStructuredViewProps } from './native-chat-view-types'
import type { NativeChatHandOff } from './use-native-chat-hand-off'

type UsageLimitActions = {
  account: ReactNode
  reserveAccount: boolean
  handOff?: () => void
  disabled: boolean
}
const UsageLimitActionsContext = createContext<UsageLimitActions | null>(null)

export function NativeChatUsageLimitActionsProvider({
  pane,
  handOffState,
  view,
  recovery,
  children
}: {
  pane: Omit<NativeChatStructuredViewProps, 'mode'>
  handOffState: NativeChatHandOff
  view: NativeChatOrcaStopView
  recovery: {
    readCurrent: boolean
    canSwitchAccount: boolean | undefined
    epoch?: string | null
  }
  children: ReactNode
}): React.JSX.Element {
  const loading = !recovery.readCurrent
  const canSwitchAccount = recovery.canSwitchAccount
  const active = view.usageLimitTurnItemId !== null
  const accountKey = JSON.stringify([
    executionHostIdForStructuredTarget(pane.target),
    pane.sessionId,
    pane.agent,
    recovery.epoch,
    view.usageLimitTurnItemId,
    recovery.readCurrent,
    pane.isVisible
  ])
  const accountIntent = useRef<object | null>(null)
  useLayoutEffect(() => {
    const current = {}
    accountIntent.current = current
    return () => {
      if (accountIntent.current === current) {
        accountIntent.current = null
      }
    }
  }, [accountKey])
  const disabled = loading || handOffState.preparing
  const canHandOff = active && handOffState.available
  let account: ReactNode = null
  if (pane.agent === 'claude' && active && pane.isVisible) {
    if (canSwitchAccount === undefined) {
      account = <ProviderAccountChatButton provider="claude" target={pane.target} disabled />
    } else if (canSwitchAccount) {
      account = (
        <ClaudeSwitcherMenu
          key={executionHostIdForStructuredTarget(pane.target)}
          claude={null}
          compact
          iconOnly
          chatAction={{
            target: pane.target,
            canSwitch: async () => {
              const current = accountIntent.current
              if (!current || !active) {
                return false
              }
              const result = await callStructuredAgentSession<AgentSessionOptionsResult>(
                pane.target,
                'agentSession.options',
                { sessionId: pane.sessionId }
              )
              return accountIntent.current === current && result.canSwitchAccount === true
            }
          }}
        />
      )
    }
  }
  const openHandOff = handOffState.open
  const actions = useMemo<UsageLimitActions>(
    () => ({
      account,
      reserveAccount: pane.agent === 'claude',
      disabled,
      ...(canHandOff || (loading && isTuiAgent(pane.agent))
        ? { handOff: () => openHandOff({ avoidSourceAgent: true }) }
        : {})
    }),
    [account, canHandOff, disabled, loading, openHandOff, pane.agent]
  )
  const resetHandOff = handOffState.reset
  const stopView = useMemo(
    () => ({
      ...view,
      continueUsageLimit: (hadFocus?: boolean) => {
        accountIntent.current = {}
        resetHandOff()
        view.continueUsageLimit(hadFocus)
      }
    }),
    [resetHandOff, view]
  )
  return (
    <UsageLimitActionsContext.Provider value={actions}>
      <NativeChatOrcaStopContext.Provider value={stopView}>
        {children}
      </NativeChatOrcaStopContext.Provider>
    </UsageLimitActionsContext.Provider>
  )
}

export function NativeChatUsageLimitActions(): React.JSX.Element | null {
  const actions = useContext(UsageLimitActionsContext)
  if (!actions || (!actions.account && !actions.handOff)) {
    return null
  }
  return (
    <div className="ml-6 space-y-2 text-chat-foreground-faint">
      <p className="text-xs">
        {translate(
          'components.native-chat.usageLimitActions.leadIn',
          'Continue this chat without waiting:'
        )}
      </p>
      <div className="flex flex-wrap gap-2">
        {actions.reserveAccount ? (
          <div className="w-32 shrink-0">{actions.account}</div>
        ) : (
          actions.account
        )}
        {actions.handOff ? (
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={actions.disabled}
            onClick={actions.handOff}
          >
            <MessageSquarePlus />
            {translate(
              'components.agentSessionContinuation.handOffToAnotherAgent',
              'Hand Off to Another Agent'
            )}
          </Button>
        ) : null}
      </div>
    </div>
  )
}

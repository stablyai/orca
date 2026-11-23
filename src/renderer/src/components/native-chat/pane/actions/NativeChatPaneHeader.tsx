import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { SessionLinkControl } from '../../SessionLinkControl'
import { Fragment } from 'react'
import { MessageSquarePlus, SquareSplitVertical } from 'lucide-react'
import { ShortcutKeyCombo } from '@/components/ui/ShortcutKeyCombo'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { useShortcutKeyComboDetails } from '@/lib/keyboard/useShortcutLabel'
import { agentForksConversations } from '../../../../../../shared/agent-launch/startup/agent-resume-argv'
import type { NativeChatTabSession } from '../../../tab-bar/session-actions/tab-session-history-switch'
import { useDocumentDarkTheme } from '@/hooks/theme/use-document-dark-theme'
import { useStructuredChatPaneActions } from './use-structured-chat-pane-actions'
import { NativeChatResumeInCliButton } from './NativeChatResumeInCliButton'
import { useBotForWorkspace } from '../../../bots/bot-workspace'
import { BotHomeBanner } from '../../../bots/home-chat/BotHomeBanner'
import { isHostedBotChatTab } from '../../../../../../shared/bots/bot-home-tab'
import { useBotHomeRuleApplies } from '@/lib/bot-host-status'
import { NativeChatSettingsButton } from '../../appearance/NativeChatSettingsButton'
import type { NativeChatStructuredViewProps } from '../../native-chat-view-types'
import type { NativeChatHandOff } from './use-native-chat-hand-off'

const HEADER_STYLE: React.CSSProperties & Record<'--orca-pane-title-bg', string> = {
  '--orca-pane-title-bg': 'var(--chat-canvas)'
}

export type NativeChatHeaderHandOff = { open: () => void; disabled: boolean }

export function NativeChatPaneHeader({
  tabId,
  worktreeId,
  groupId,
  nativeChat,
  focused,
  colorScheme,
  handOff,
  target
}: {
  tabId: string
  worktreeId: string
  groupId: string
  nativeChat: NativeChatTabSession
  focused: boolean
  colorScheme: React.CSSProperties['colorScheme']
  handOff?: NativeChatHeaderHandOff
  target?: RuntimeClientTarget
}): React.JSX.Element {
  const t = useTranslate()
  const actions = useStructuredChatPaneActions(tabId, worktreeId, groupId)
  const tabHostId = useAppStore(
    (state) =>
      state.unifiedTabsByWorktree[worktreeId]?.find((entry) => entry.id === tabId)?.executionHostId
  )
  const bot = useBotForWorkspace(worktreeId, tabHostId)
  // A bot's chats stay native chats.
  const onBotPage = bot !== null
  const homeRule = useBotHomeRuleApplies(bot)
  const hostedChat = useAppStore((state) => {
    const tab = state.unifiedTabsByWorktree[worktreeId]?.find((entry) => entry.id === tabId)
    return Boolean(
      state.workspaceSessionReady &&
      tab &&
      tab.entityId === nativeChat.sessionId &&
      isHostedBotChatTab(tab, bot)
    )
  })
  const documentDark = useDocumentDarkTheme()
  const light = colorScheme ? colorScheme === 'light' : !documentDark
  const split = t('components.native-chat.splitRight', 'Split Right')
  const splitShortcutCombos = useShortcutKeyComboDetails('terminal.splitRight')
  const handOffLabel = t(
    'components.agentSessionContinuation.handOffToAnotherAgent',
    'Hand off to agent'
  )
  const homeBot = hostedChat && homeRule && bot?.chatSessionId === nativeChat.sessionId ? bot : null
  return (
    <div
      className="pane-title-bar z-20"
      data-chromeless=""
      data-active-pane={focused ? '' : undefined}
      data-pane-title-surface={light ? 'light' : 'dark'}
      style={HEADER_STYLE}
    >
      {homeBot ? <BotHomeBanner bot={homeBot} /> : null}
      <div className="pane-title-actions ml-auto flex shrink-0 items-center gap-0">
        {nativeChat.sessionId && target ? (
          <SessionLinkControl sessionId={nativeChat.sessionId} target={target} />
        ) : null}
        {handOff && focused ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="pane-title"
                size="icon-xs"
                aria-label={handOffLabel}
                disabled={handOff.disabled}
                onClick={(event) => {
                  event.stopPropagation()
                  handOff.open()
                }}
              >
                <MessageSquarePlus className="size-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={4}>
              {handOffLabel}
            </TooltipContent>
          </Tooltip>
        ) : null}
        {!onBotPage && nativeChat.agent && agentForksConversations(nativeChat.agent) ? (
          <NativeChatResumeInCliButton
            tabId={tabId}
            worktreeId={worktreeId}
            nativeChat={nativeChat}
          />
        ) : null}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="pane-title"
              size="icon-xs"
              aria-label={split}
              data-contextual-tour-target={focused ? 'chat-pane-split-target' : undefined}
              onClick={(event) => {
                event.stopPropagation()
                actions.onSplitRight()
              }}
            >
              <SquareSplitVertical className="size-3" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={4}>
            <span className="inline-flex items-center gap-1.5">
              <span>
                {split}
                {splitShortcutCombos.length > 0 ? ': ' : null}
              </span>
              {splitShortcutCombos.map((shortcut, index) => (
                <Fragment key={JSON.stringify([shortcut.keys, shortcut.doubleTap])}>
                  {index > 0 ? <span>{', '}</span> : null}
                  <ShortcutKeyCombo
                    keys={shortcut.keys}
                    doubleTap={shortcut.doubleTap}
                    className="gap-0.5"
                    keyCapClassName="min-w-0 border-background/30 bg-background/10 px-1 py-0 text-3xs text-background shadow-none"
                    separatorClassName="mx-0 text-3xs text-background/70"
                  />
                </Fragment>
              ))}
            </span>
          </TooltipContent>
        </Tooltip>
        <NativeChatSettingsButton />
      </div>
    </div>
  )
}

export function nativeChatPaneHeader(
  view: Pick<
    NativeChatStructuredViewProps,
    | 'tabId'
    | 'groupId'
    | 'sessionId'
    | 'agent'
    | 'isVisible'
    | 'isFocusedGroup'
    | 'contextMenuActions'
    | 'target'
  >,
  worktreeId: string | null,
  colorScheme: React.CSSProperties['colorScheme'],
  handOff?: NativeChatHandOff
): React.JSX.Element | null {
  return view.isVisible && worktreeId && view.groupId && !view.contextMenuActions ? (
    <NativeChatPaneHeader
      tabId={view.tabId}
      worktreeId={worktreeId}
      groupId={view.groupId}
      nativeChat={{ sessionId: view.sessionId, agent: view.agent }}
      target={view.target}
      focused={view.isFocusedGroup}
      colorScheme={colorScheme}
      handOff={
        handOff?.available
          ? { open: handOff.open, disabled: handOff.preparing || handOff.dialog !== null }
          : undefined
      }
    />
  ) : null
}

import { Fragment } from 'react'
import { MessageSquarePlus, SquareSplitVertical, X } from 'lucide-react'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { useShortcutKeyComboDetails } from '@/hooks/useShortcutLabel'
import { agentForksConversations } from '../../../../shared/agent-resume-argv'
import type { NativeChatTabSession } from '../tab-bar/tab-session-history-switch'
import { useDocumentDarkTheme } from '@/hooks/use-document-dark-theme'
import { useStructuredChatPaneActions } from './use-structured-chat-pane-actions'
import { NativeChatResumeInCliButton } from './NativeChatResumeInCliButton'
import type { NativeChatStructuredViewProps } from './native-chat-view-types'
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
  handOff
}: {
  tabId: string
  worktreeId: string
  groupId: string
  nativeChat: NativeChatTabSession
  focused: boolean
  colorScheme: React.CSSProperties['colorScheme']
  handOff?: NativeChatHeaderHandOff
}): React.JSX.Element {
  const actions = useStructuredChatPaneActions(tabId, worktreeId, groupId)
  const documentDark = useDocumentDarkTheme()
  const light = colorScheme ? colorScheme === 'light' : !documentDark
  const split = translate('auto.components.cmd.j.quick.actions.splitChatRight', 'Split Chat Right')
  const splitShortcutCombos = useShortcutKeyComboDetails('terminal.splitRight')
  const handOffLabel = translate(
    'components.agentSessionContinuation.handOffToAnotherAgent',
    'Hand Off to Another Agent'
  )
  return (
    <div
      className="pane-title-bar z-20"
      data-chromeless=""
      data-active-pane={focused ? '' : undefined}
      data-pane-title-surface={light ? 'light' : 'dark'}
      style={HEADER_STYLE}
    >
      <div className="pane-title-actions ml-auto flex shrink-0 items-center gap-0">
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
        {nativeChat.agent && agentForksConversations(nativeChat.agent) ? (
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
        {actions.canClosePane ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="pane-title-close"
                size="icon-xs"
                aria-label={actions.closeLabel}
                onClick={(event) => {
                  event.stopPropagation()
                  actions.onClosePane()
                }}
              >
                <X className="size-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={4}>
              {actions.closeLabel}
            </TooltipContent>
          </Tooltip>
        ) : null}
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

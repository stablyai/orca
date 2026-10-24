import { isNativeChatEnabled } from '../../../../shared/structured-native-chat-launch-route'
import { SquareTerminal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { useInPlaceSwitchCapability } from '@/lib/in-place-switch-support'
import { AI_VAULT_AGENTS } from '../../../../shared/ai-vault-types'
import { SwitchToCliTooltipText } from '../right-sidebar/ai-vault-session-cli-fork-copy'
import {
  runNativeChatCliSwitch,
  useNativeChatCliSwitchPending
} from '../tab-bar/native-chat-cli-switch-run'
import { resolveTabSessionHistorySubject } from '../tab-bar/tab-session-history-switch'
import { NativeChatFindBar } from './NativeChatFindBar'
import type { NativeChatFind } from './use-native-chat-find'
import type { NativeChatStructuredViewProps } from './native-chat-view-types'
import { useNativeChatTabOwnerWorktreeId } from './use-native-chat-tab-owner'

/** The chat's top-right corner: its find bar while open, else its icon-only "Switch to CLI". */
export function NativeChatTopRightControls({
  find,
  session,
  working,
  inline = false
}: {
  find: NativeChatFind
  session: Pick<NativeChatStructuredViewProps, 'tabId' | 'sessionId' | 'agent' | 'isVisible'>
  working: boolean
  inline?: boolean
}): React.JSX.Element | null {
  const worktreeId = useNativeChatTabOwnerWorktreeId(session.tabId)
  // A primitive, so the selector is stable; the chat's host is where its History row lives.
  const hostId = useAppStore((state) => {
    const subject = worktreeId
      ? resolveTabSessionHistorySubject(state, {
          tab: { id: session.tabId, worktreeId },
          nativeChat: { sessionId: session.sessionId, agent: session.agent }
        })
      : null
    return subject?.kind === 'chat' ? subject.request.executionHostScope : null
  })
  const agent = AI_VAULT_AGENTS.find((candidate) => candidate === session.agent)
  const inPlace = useInPlaceSwitchCapability(hostId, agent)
  const pending = useNativeChatCliSwitchPending(session.sessionId)
  const enabled = useAppStore((state) => isNativeChatEnabled(state.settings))
  if (find.isOpen) {
    return <NativeChatFindBar find={find} isVisible={session.isVisible} />
  }
  if (!enabled || !worktreeId || !hostId || !agent || (inPlace === false && agent !== 'omp')) {
    return null
  }
  const label = translate('components.tab.bar.switch.toCli', 'Switch to CLI')
  return (
    <div className={inline ? 'flex' : 'absolute top-2 right-4 z-20'}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant={inline ? 'pane-title' : 'ghost'}
            size="icon-xs"
            aria-label={label}
            // Not `disabled` while a reply runs: the tooltip has to say why.
            aria-disabled={working || undefined}
            disabled={pending || inPlace !== true}
            onClick={() => {
              if (!working && inPlace === true) {
                void runNativeChatCliSwitch({
                  sessionId: session.sessionId,
                  workspaceId: worktreeId,
                  executionHostId: hostId,
                  agent,
                  chatTabId: session.tabId
                })
              }
            }}
          >
            <SquareTerminal />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={4}>
          {inPlace === false ? (
            translate(
              'components.tab.bar.switch.unavailable',
              'Switching {{agent}} is not available yet.',
              { agent: session.agent }
            )
          ) : working ? (
            translate(
              'components.tab.bar.switch.waitForReply',
              'Wait for the reply to finish or stop it, then switch.'
            )
          ) : (
            <SwitchToCliTooltipText agent={agent} />
          )}
        </TooltipContent>
      </Tooltip>
    </div>
  )
}

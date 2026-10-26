import { isNativeChatEnabled } from '../../../../shared/structured-native-chat-launch-route'
import { useShallow } from 'zustand/react/shallow'
import { MessagesSquare } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { agentLabel } from '../../../../shared/ai-vault-session-filters'
import {
  resolveCliChatResumeSource,
  useCliChatResumeCapability
} from '../tab-bar/cli-chat-resume-source'
import { runCliChatResume, useCliChatResumePending } from '../tab-bar/cli-chat-resume-run'

export function TerminalPaneResumeInChatButton({
  tabId,
  worktreeId,
  paneKey
}: {
  tabId: string
  worktreeId: string
  paneKey: string
}): React.JSX.Element | null {
  const source = useAppStore(
    useShallow((state) =>
      resolveCliChatResumeSource(state, { tab: { id: tabId, worktreeId }, paneKey })
    )
  )
  const capability = useCliChatResumeCapability(worktreeId, source?.agent)
  // The host's writer check decides; this only explains the refusal before the click.
  const running = useAppStore((state) => {
    const foreground = state.paneForegroundAgentByPaneKey[paneKey]
    return (
      state.agentStatusByPaneKey[paneKey] !== undefined ||
      (!!foreground?.agent && !foreground.shellForeground)
    )
  })
  const pending = useCliChatResumePending(source)
  const enabled = useAppStore((state) => isNativeChatEnabled(state.settings))
  if (!enabled && capability !== false) {
    return null
  }
  const label =
    capability === false
      ? translate(
          'auto.components.right.sidebar.AiVaultSessionRow.resumeInNewNativeChat',
          'Resume in New Chat'
        )
      : translate('components.tab.bar.switch.toNativeChat', 'Switch to native chat')
  const tooltip = !source
    ? translate(
        'components.tab.bar.switch.noConversation',
        'No saved conversation is available in this terminal yet.'
      )
    : capability === false
      ? label
      : running && source
        ? translate(
            'components.tab.bar.switch.exitAgentFirst',
            'Exit {{agent}} in this terminal to switch.',
            {
              agent: agentLabel(source.agent)
            }
          )
        : translate(
            'components.tab.bar.switch.toNativeChatTooltip',
            'Switch to native chat: continues the same conversation in a chat, in this tab.'
          )

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="pane-title"
          size="icon-xs"
          aria-label={label}
          disabled={!source || pending || capability === undefined}
          // Not `disabled`: the tooltip has to say why.
          aria-disabled={(capability === true && running) || undefined}
          aria-busy={pending || undefined}
          onClick={(event) => {
            event.stopPropagation()
            if (source && capability !== undefined && (capability === false || !running)) {
              void runCliChatResume(source)
            }
          }}
        >
          <MessagesSquare className="size-3" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4}>
        {tooltip}
      </TooltipContent>
    </Tooltip>
  )
}

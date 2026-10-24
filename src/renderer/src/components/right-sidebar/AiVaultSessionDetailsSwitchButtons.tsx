import { useAppStore } from '@/store'
import { isNativeChatEnabled } from '../../../../shared/structured-native-chat-launch-route'
import { MessagesSquare, SquareTerminal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { useAiVaultInPlaceAgent, useInPlaceSwitchCapability } from '@/lib/in-place-switch-support'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { ResumeInNewCliTooltipText, SwitchToCliTooltipText } from './ai-vault-session-cli-fork-copy'

/** The details bar's chat and CLI moves: in place where the row's host switches its agent. */
export function AiVaultSessionDetailsSwitchButtons({
  session,
  onResumeInNewChat,
  onResumeInNewCli
}: {
  session: Pick<AiVaultSession, 'agent' | 'executionHostId'>
  onResumeInNewChat?: () => void
  onResumeInNewCli?: () => void
}): React.JSX.Element | null {
  const inPlaceAgent = useAiVaultInPlaceAgent(session)
  const switchLoading =
    useInPlaceSwitchCapability(session.executionHostId, session.agent) === undefined
  const enabled = useAppStore((state) => isNativeChatEnabled(state.settings))
  if (!enabled && (inPlaceAgent !== undefined || switchLoading)) {
    return null
  }
  return (
    <>
      {onResumeInNewChat ? (
        <Button
          type="button"
          variant="secondary"
          size="xs"
          draggable={false}
          disabled={switchLoading}
          onClick={(event) => {
            event.stopPropagation()
            onResumeInNewChat()
          }}
          className="h-7 shrink-0 px-2.5 text-[11px]"
        >
          <MessagesSquare className="size-3.5" />
          {inPlaceAgent
            ? translate('components.tab.bar.switch.toNativeChat', 'Switch to native chat')
            : translate(
                'auto.components.right.sidebar.AiVaultSessionRow.resumeInNewNativeChat',
                'Resume in New Chat'
              )}
        </Button>
      ) : null}
      {onResumeInNewCli ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="secondary"
              size="xs"
              draggable={false}
              disabled={switchLoading}
              onClick={(event) => {
                event.stopPropagation()
                onResumeInNewCli()
              }}
              className="h-7 shrink-0 px-2.5 text-[11px]"
            >
              <SquareTerminal className="size-3.5" />
              {inPlaceAgent
                ? translate('components.tab.bar.switch.toCli', 'Switch to CLI')
                : translate(
                    'auto.components.right.sidebar.AiVaultSessionRow.resumeInNewCli',
                    'Resume in New Terminal'
                  )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {inPlaceAgent ? (
              <SwitchToCliTooltipText agent={inPlaceAgent} />
            ) : (
              <ResumeInNewCliTooltipText />
            )}
          </TooltipContent>
        </Tooltip>
      ) : null}
    </>
  )
}

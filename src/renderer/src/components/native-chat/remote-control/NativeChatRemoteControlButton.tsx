import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { ClaudeRemoteControlIcon } from './ClaudeRemoteControlIcon'
import { NativeChatRemoteControlMenuItems } from './NativeChatRemoteControlMenuItems'
import { agentSessionProviderRemoteControlIsPending } from '../../../../../shared/agent-session/remote-control/agent-session-provider-remote-control'
import { nativeChatRemoteControlStatus } from './native-chat-remote-control-actions'
import { useNativeChatRemoteControl } from './use-native-chat-remote-control'

/** Shown while the chat has a link, and on the focused pane so it can be turned on. */
export function NativeChatRemoteControlButton({
  sessionId,
  target,
  focused
}: {
  sessionId: string
  target: RuntimeClientTarget
  focused: boolean
}): React.JSX.Element | null {
  const t = useTranslate()
  const remoteControl = useNativeChatRemoteControl(target, sessionId)
  const { link } = remoteControl
  const pending = agentSessionProviderRemoteControlIsPending(remoteControl)
  if (!remoteControl.set || (!link && !pending && !focused)) {
    return null
  }
  const status = nativeChatRemoteControlStatus(remoteControl)
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="pane-title"
              size="icon-xs"
              aria-label={status}
              data-remote-control-state={link?.state ?? (pending ? 'pending' : 'off')}
              onClick={(event) => event.stopPropagation()}
            >
              <ClaudeRemoteControlIcon
                size={13}
                state={link?.state ?? (pending ? 'pending' : undefined)}
              />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={4}>
          {t('components.native-chat.remoteControl.label', 'Remote Control')}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
        <NativeChatRemoteControlMenuItems remoteControl={remoteControl} withStatus />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

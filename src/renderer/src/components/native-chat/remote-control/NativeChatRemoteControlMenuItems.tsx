import { Copy, ExternalLink, RadioTower } from 'lucide-react'
import { DropdownMenuItem, DropdownMenuLabel } from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import { openAppHttpLink } from '@/lib/browser/navigation/app-http-link-open'
import { copyRichMarkdownLink } from '@/components/editor/rich-markdown/links/rich-markdown-link-clipboard'
import { agentSessionProviderRemoteControlIsOn } from '../../../../../shared/agent-session/remote-control/agent-session-provider-remote-control'
import {
  nativeChatRemoteControlStatus,
  setNativeChatRemoteControl
} from './native-chat-remote-control-actions'
import type { NativeChatRemoteControl } from './use-native-chat-remote-control'

/** The chat's Remote Control actions, shared by the pane header and the pane menu. */
export function NativeChatRemoteControlMenuItems({
  remoteControl,
  withStatus
}: {
  remoteControl: NativeChatRemoteControl
  /** The header's own menu leads with what the link is doing; the pane menu stays terse. */
  withStatus: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const { link } = remoteControl
  const url = link?.sessionUrl
  const on = agentSessionProviderRemoteControlIsOn(remoteControl)
  return (
    <>
      {withStatus ? (
        <DropdownMenuLabel className="max-w-72 whitespace-normal">
          {nativeChatRemoteControlStatus(remoteControl)}
        </DropdownMenuLabel>
      ) : null}
      {url ? (
        <>
          <DropdownMenuItem onSelect={() => openAppHttpLink(url, { destination: 'system' })}>
            <ExternalLink />
            {t('components.native-chat.remoteControl.openOnClaudeAi', 'Open on claude.ai')}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void copyRichMarkdownLink(url)}>
            <Copy />
            {t('components.native-chat.remoteControl.copyLink', 'Copy Remote Control Link')}
          </DropdownMenuItem>
        </>
      ) : null}
      <DropdownMenuItem onSelect={() => void setNativeChatRemoteControl(remoteControl, !on)}>
        <RadioTower />
        {!on
          ? t('components.native-chat.remoteControl.connect', 'Connect to Remote Control')
          : link
            ? t('components.native-chat.remoteControl.disconnect', 'Disconnect Remote Control')
            : t('components.native-chat.remoteControl.turnOff', 'Turn Off Remote Control')}
      </DropdownMenuItem>
    </>
  )
}

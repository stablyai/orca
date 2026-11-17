import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { agentSessionProviderRemoteControlIsPending } from '../../../../../shared/agent-session/remote-control/agent-session-provider-remote-control'
import type { NativeChatRemoteControl } from './use-native-chat-remote-control'

function pendingText(): string {
  return translate(
    'components.native-chat.remoteControl.pending',
    "Remote Control connects with this chat's next message"
  )
}

/** What the link is doing, in words that never claim more than Claude reported. */
export function nativeChatRemoteControlStatus(
  remoteControl: Pick<NativeChatRemoteControl, 'link' | 'choice'>
): string {
  const { link } = remoteControl
  if (agentSessionProviderRemoteControlIsPending(remoteControl)) {
    return pendingText()
  }
  switch (link?.state) {
    case 'connected':
      return translate(
        'components.native-chat.remoteControl.connected',
        'Connected to Remote Control'
      )
    case 'connecting':
      return translate(
        'components.native-chat.remoteControl.connecting',
        'Connecting to Remote Control…'
      )
    case 'failed':
      return link.detail
        ? translate(
            'components.native-chat.remoteControl.failedWithDetail',
            'Remote Control failed: {{detail}}',
            { detail: link.detail }
          )
        : translate('components.native-chat.remoteControl.failed', 'Remote Control failed')
    case 'policy-disabled':
      return translate(
        'components.native-chat.remoteControl.policyDisabled',
        'Remote Control is turned off by your organization'
      )
    default:
      return translate('components.native-chat.remoteControl.off', 'Remote Control is off')
  }
}

// Module level: React Compiler can't lower try/catch inside a component.
/** Saves the chat's choice; false, with a toast saying why, when the host refused it. */
export async function setNativeChatRemoteControl(
  remoteControl: NativeChatRemoteControl,
  on: boolean
): Promise<boolean> {
  try {
    const saved = await remoteControl.set?.(on ? 'on' : 'off')
    // A chat at rest has no agent to connect yet; say when it will, rather than look ignored.
    if (on && saved && !saved.live) {
      toast(pendingText())
    }
    return saved !== undefined
  } catch (error) {
    toast.error(
      on
        ? translate(
            'components.native-chat.remoteControl.connectFailed',
            'Unable to connect to Remote Control'
          )
        : translate(
            'components.native-chat.remoteControl.disconnectFailed',
            'Unable to disconnect from Remote Control'
          ),
      { description: error instanceof Error ? error.message : String(error) }
    )
    return false
  }
}

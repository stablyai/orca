import { useState } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import type { AgentType } from '../../../../../shared/agent-status/contracts/agent-status-types'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { NativeChatComposerNotice } from '../composer/controls/native-chat-composer-notice'
import {
  nativeChatRemoteControlStatus,
  setNativeChatRemoteControl
} from './native-chat-remote-control-actions'
import { useNativeChatRemoteControl } from './use-native-chat-remote-control'

/** What the person must read about this chat's Remote Control: a link they did not turn on, or one
 *  that failed. Dismissing hides that one state; a new state shows again. */
export function useNativeChatRemoteControlNotice({
  target,
  sessionId,
  agent
}: {
  target: RuntimeClientTarget
  sessionId: string
  agent: AgentType
}): NativeChatComposerNotice | null {
  const t = useTranslate()
  const remoteControl = useNativeChatRemoteControl(target, sessionId)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const { link } = remoteControl
  if (agent !== 'claude' || !link || !remoteControl.set) {
    return null
  }
  const key = `remote-control:${link.state}:${link.enabledByDefault === true}:${link.detail ?? ''}`
  if (dismissed === key) {
    return null
  }
  const onDismiss = () => setDismissed(key)
  if (link.state === 'failed') {
    return {
      key,
      kind: 'remote-control',
      tone: 'warning',
      text: nativeChatRemoteControlStatus(remoteControl),
      action: {
        label: t('components.native-chat.remoteControl.retry', 'Retry'),
        onClick: () => void setNativeChatRemoteControl(remoteControl, true)
      },
      onDismiss
    }
  }
  if (link.state === 'policy-disabled') {
    return {
      key,
      kind: 'remote-control',
      tone: 'muted',
      text: nativeChatRemoteControlStatus(remoteControl),
      onDismiss
    }
  }
  return link.enabledByDefault
    ? {
        key,
        kind: 'remote-control',
        tone: 'muted',
        text: t(
          'components.native-chat.remoteControl.onByDefault',
          'Remote Control is on by default for your account, so this chat also appears in the Claude app and on claude.ai.'
        ),
        action: {
          label: t('components.native-chat.remoteControl.disconnect', 'Disconnect Remote Control'),
          onClick: () => void setNativeChatRemoteControl(remoteControl, false)
        },
        onDismiss
      }
    : null
}

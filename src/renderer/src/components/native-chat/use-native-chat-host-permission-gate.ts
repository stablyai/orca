import { newChatPermissionModeForSettings } from '../../../../shared/agent-chat-permission-mode'
import { translate } from '@/i18n/i18n'
import { hostPermissionRefusedText } from '@/lib/structured-agent-session-launch-permission-notice'
import { useStructuredChatHostPermissionVerdict } from '@/runtime/structured-chat-host-permission'
import { useAppStore } from '@/store'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { NativeChatComposerNotice } from './native-chat-composer-notice'

export type NativeChatHostPermissionGate = {
  /** Present while Send is held: what the user can do about it. */
  sendBlockedReason: string | null
  notice: NativeChatComposerNotice | null
}

const OPEN: NativeChatHostPermissionGate = { sendBlockedReason: null, notice: null }

/** Holds Send on a paired host that would run this chat with more access than this client asks
 *  for: an older host ignores per-chat modes and runs its own Agent Permissions. */
export function useNativeChatHostPermissionGate(
  target: RuntimeClientTarget,
  agent: string,
  agentLabel: string
): NativeChatHostPermissionGate {
  const verdict = useStructuredChatHostPermissionVerdict(target, agent)
  const requested = useAppStore((state) => newChatPermissionModeForSettings(agent, state.settings))
  if (verdict.kind === 'allowed') {
    return OPEN
  }
  if (verdict.kind === 'checking') {
    return {
      sendBlockedReason: translate(
        'components.native-chat.hostPermission.checking',
        "Checking this host's chat permissions…"
      ),
      notice: null
    }
  }
  const text = hostPermissionRefusedText(agentLabel, verdict.kind, requested)
  return {
    sendBlockedReason: text,
    notice: { key: `host-permission:${verdict.kind}`, kind: 'host', tone: 'warning', text }
  }
}

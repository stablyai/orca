import { newChatPermissionModeForSettings } from '../../../../shared/agent-chat-permission-mode'
import { translate } from '@/i18n/i18n'
import { hostPermissionRefusedText } from '@/lib/structured-agent-session-launch-permission-notice'
import { useStructuredChatHostPermissionVerdict } from '@/runtime/structured-chat-host-permission'
import { useAppStore } from '@/store'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { NativeChatComposerNotice } from './native-chat-composer-notice'

export type NativeChatHostPermissionGate = {
  /** User action required to unblock Send. */
  sendBlockedReason: string | null
  notice: NativeChatComposerNotice | null
}

const OPEN: NativeChatHostPermissionGate = { sendBlockedReason: null, notice: null }

/** Block sends to older paired hosts that ignore per-chat modes and would grant more access than requested. */
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
    notice: {
      key: `host-permission:${verdict.kind}`,
      kind: 'host',
      tone: 'warning',
      text,
      ...(verdict.kind === 'unverified'
        ? {
            action: {
              label: translate('components.native-chat.hostPermission.checkAgain', 'Check again'),
              onClick: verdict.checkAgain
            }
          }
        : {})
    }
  }
}

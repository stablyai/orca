import { newChatPermissionModeForSettings } from '../../../../../shared/agent-launch/permissions/agent-chat-permission-mode'
import { useTranslate } from '@/i18n/use-translate'
import { hostPermissionRefusedText } from '@/lib/agent-session/launch/structured-agent-session-launch-permission-notice'
import { useStructuredChatHostPermissionVerdict } from '@/runtime/native-chat/host-capabilities/structured-chat-host-permission'
import { useAppStore } from '@/store/index'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import type { NativeChatComposerNotice } from '@/components/native-chat/composer/controls/native-chat-composer-notice'

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
  const t = useTranslate()
  const verdict = useStructuredChatHostPermissionVerdict(target, agent)
  const requested = useAppStore((state) => newChatPermissionModeForSettings(agent, state.settings))
  if (verdict.kind === 'allowed') {
    return OPEN
  }
  if (verdict.kind === 'checking') {
    return {
      sendBlockedReason: t(
        'components.native-chat.hostPermission.checking',
        "Checking this host's chat permissions…"
      ),
      notice: null
    }
  }
  const text = hostPermissionRefusedText(agentLabel, verdict.kind, requested, t)
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
              label: t('components.native-chat.hostPermission.checkAgain', 'Check again'),
              onClick: verdict.checkAgain
            }
          }
        : {})
    }
  }
}

import type { LucideIcon } from 'lucide-react'
import { FilePenLine, Hand, ShieldAlert, ShieldCheck } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import {
  AGENT_CHAT_PERMISSION_MODE_ICON_NAMES,
  type AgentChatPermissionMode,
  type AgentChatPermissionModeIconName
} from '../../../../shared/agent-chat-permission-mode'

const ICONS_BY_NAME: Record<AgentChatPermissionModeIconName, LucideIcon> = {
  Hand,
  FilePenLine,
  ShieldCheck,
  ShieldAlert
}

export const NATIVE_CHAT_PERMISSION_MODE_ICONS = {
  ask: ICONS_BY_NAME[AGENT_CHAT_PERMISSION_MODE_ICON_NAMES.ask],
  'accept-edits': ICONS_BY_NAME[AGENT_CHAT_PERMISSION_MODE_ICON_NAMES['accept-edits']],
  auto: ICONS_BY_NAME[AGENT_CHAT_PERMISSION_MODE_ICON_NAMES.auto],
  'full-access': ICONS_BY_NAME[AGENT_CHAT_PERMISSION_MODE_ICON_NAMES['full-access']]
} as const satisfies Record<AgentChatPermissionMode, LucideIcon>

export function nativeChatPermissionModeLabel(mode: AgentChatPermissionMode): string {
  switch (mode) {
    case 'ask':
      return translate('components.native-chat.composer.permissionAsk', 'Ask for approval')
    case 'accept-edits':
      return translate('components.native-chat.composer.permissionAcceptEdits', 'Accept edits')
    case 'auto':
      return translate('components.native-chat.composer.permissionAuto', 'Approve for me')
    case 'full-access':
      return translate('components.native-chat.composer.permissionFullAccess', 'Full access')
  }
}

/** `agent` absent describes the mode for every agent, as the new-chat setting does. */
export function nativeChatPermissionModeDescription(
  mode: AgentChatPermissionMode,
  agent?: string | null
): string {
  switch (mode) {
    case 'ask':
      if (agent !== 'claude') {
        return translate(
          'components.native-chat.composer.permissionAskSharedDescription',
          "Asks before edits or commands it isn't already allowed to make"
        )
      }
      return translate(
        'components.native-chat.composer.permissionAskDescription',
        "Asks before edits and commands your settings don't allow"
      )
    case 'accept-edits':
      if (agent === 'antigravity') {
        return translate(
          'components.native-chat.composer.permissionAcceptEditsAntigravityDescription',
          'Approves file edits; asks for the rest'
        )
      }
      return translate(
        'components.native-chat.composer.permissionAcceptEditsDescription',
        'Approves file edits and file commands; asks for the rest'
      )
    case 'auto':
      return translate(
        'components.native-chat.composer.permissionAutoDescription',
        'Reviews approval requests for you'
      )
    case 'full-access':
      if (agent === 'codex') {
        return translate(
          'components.native-chat.composer.permissionFullAccessCodexDescription',
          'Never asks; can edit any file and use the network'
        )
      }
      if (agent !== 'claude') {
        return translate(
          'components.native-chat.composer.permissionFullAccessSharedDescription',
          'Never asks before edits or commands'
        )
      }
      return translate(
        'components.native-chat.composer.permissionFullAccessDescription',
        'Never asks before edits or commands'
      )
  }
}

export function nativeChatPermissionPickerTitle(): string {
  return translate('components.native-chat.composer.permissions', 'Permissions')
}

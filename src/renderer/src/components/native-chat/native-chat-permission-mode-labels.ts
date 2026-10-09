import type { LucideIcon } from 'lucide-react'
import { FilePenLine, Hand, ShieldAlert, ShieldCheck } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { AgentChatPermissionMode } from '../../../../shared/agent-chat-permission-mode'
import type { SessionOptionsSurface } from '../../../../shared/native-chat-session-options'

/** The composer's permission pill: present only where the host offers a picker for this chat. */
export type NativeChatPermissionModePickerState = {
  provider?: string | null
  current: AgentChatPermissionMode
  supported: readonly AgentChatPermissionMode[]
  /** This pick is in flight. */
  pending: boolean
  /** Nothing can carry a pick right now: another write is in flight, or the launch has no fence. */
  disabled: boolean
  setMode: (mode: AgentChatPermissionMode) => Promise<boolean>
}

/** Permission choices belong to the session, apart from the per-model controls. */
export type StructuredSessionOptionsSurface = SessionOptionsSurface & {
  permissionPicker?: NativeChatPermissionModePickerState | null
}

export const NATIVE_CHAT_PERMISSION_MODE_ICONS = {
  ask: Hand,
  'accept-edits': FilePenLine,
  auto: ShieldCheck,
  bypass: ShieldAlert
} as const satisfies Record<AgentChatPermissionMode, LucideIcon>

export function nativeChatPermissionModeLabel(mode: AgentChatPermissionMode): string {
  switch (mode) {
    case 'ask':
      return translate('components.native-chat.composer.permissionAsk', 'Ask for approval')
    case 'accept-edits':
      return translate('components.native-chat.composer.permissionAcceptEdits', 'Accept edits')
    case 'auto':
      return translate('components.native-chat.composer.permissionAuto', 'Approve for me')
    case 'bypass':
      return translate('components.native-chat.composer.permissionBypass', 'Full access')
  }
}

export function nativeChatPermissionModeDescription(
  mode: AgentChatPermissionMode,
  provider?: string | null
): string {
  switch (mode) {
    case 'ask':
      if (provider === 'codex') {
        return translate(
          'components.native-chat.composer.permissionAskCodexDescription',
          'Works inside the workspace sandbox; asks before going beyond it'
        )
      }
      if (provider !== 'claude') {
        return translate(
          'components.native-chat.composer.permissionAskSharedDescription',
          'Claude asks unless your settings allow it; Codex asks beyond the workspace sandbox'
        )
      }
      return translate(
        'components.native-chat.composer.permissionAskDescription',
        "Asks before edits and commands your settings don't allow"
      )
    case 'accept-edits':
      return translate(
        'components.native-chat.composer.permissionAcceptEditsDescription',
        'Approves file edits and file commands; asks for the rest'
      )
    case 'auto':
      return translate(
        'components.native-chat.composer.permissionAutoDescription',
        'Reviews approval requests for you'
      )
    case 'bypass':
      if (provider === 'codex') {
        return translate(
          'components.native-chat.composer.permissionBypassCodexDescription',
          'Never asks; no sandbox'
        )
      }
      if (provider !== 'claude') {
        return translate(
          'components.native-chat.composer.permissionBypassSharedDescription',
          'Skips approval prompts; Codex also runs without its sandbox'
        )
      }
      return translate(
        'components.native-chat.composer.permissionBypassDescription',
        'Skips approval prompts; your Claude rules and sandbox still apply'
      )
  }
}

export function nativeChatPermissionPickerTitle(): string {
  return translate('components.native-chat.composer.permissions', 'Permissions')
}

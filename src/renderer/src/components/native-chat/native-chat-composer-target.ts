import { translate } from '@/i18n/i18n'
import { isRemoteRuntimePtyId } from '@/runtime/runtime-terminal-inspection'
import type { getSettingsForAgentTabRuntimeOwner } from '@/lib/agent-paste-draft'

export type NativeChatResolvedTarget = {
  ptyId: string
  settings: ReturnType<typeof getSettingsForAgentTabRuntimeOwner>
}

export function nativeChatComposerPlaceholder(hasPty: boolean, canSend: boolean): string {
  if (!hasPty) {
    return translate(
      'components.native-chat.composer.noPty',
      'No live terminal — toggle back to reconnect.'
    )
  }
  if (!canSend) {
    return translate('components.native-chat.composer.locked', 'Input is held by another device.')
  }
  return translate('components.native-chat.composer.placeholder', 'Send a message…')
}

export function nativeChatComposerTargetIsRemote(ptyId: string | null): boolean {
  return ptyId !== null && isRemoteRuntimePtyId(ptyId)
}

export function formatNativeChatFileReference(filePath: string): string {
  const escaped = filePath.replace(/"/g, '\\"')
  return /\s/.test(filePath) ? `@"${escaped}"` : `@${filePath}`
}

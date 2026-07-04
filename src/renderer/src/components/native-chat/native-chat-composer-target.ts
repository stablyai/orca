import { translate } from '@/i18n/i18n'
import { isRemoteRuntimePtyId } from '@/runtime/runtime-terminal-inspection'
import type { getSettingsForAgentTabRuntimeOwner } from '@/lib/agent-paste-draft'

export type NativeChatResolvedTarget = {
  ptyId: string
  settings: ReturnType<typeof getSettingsForAgentTabRuntimeOwner>
}

export type NativeChatComposerPendingPromptKind = 'approval' | 'question'

/** Upper bound for clipboard text pulled into the composer via Cmd/Ctrl+V, so a
 *  pathological clipboard can't stall the round-trip. */
export const NATIVE_CHAT_CONTEXT_PASTE_MAX_BYTES = 16 * 1024 * 1024

export function nativeChatComposerPlaceholder(
  hasPty: boolean,
  canSend: boolean,
  pendingPromptKind: NativeChatComposerPendingPromptKind | null = null
): string {
  if (!hasPty) {
    return translate(
      'components.native-chat.composer.noPty',
      'No live terminal — toggle back to reconnect.'
    )
  }
  if (!canSend) {
    return translate('components.native-chat.composer.locked', 'Input is held by another device.')
  }
  if (pendingPromptKind === 'approval') {
    return translate(
      'components.native-chat.composer.pendingApproval',
      'Resolve the approval above to continue.'
    )
  }
  if (pendingPromptKind === 'question') {
    return translate(
      'components.native-chat.composer.pendingQuestion',
      'Use the question panel above to answer.'
    )
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

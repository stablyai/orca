import { translate } from '@/i18n/i18n'
import type { NativeChatAttachmentOwner } from './native-chat-attachment-upload'

export type NativeChatResolvedPathOptions = {
  /** Revalidates internal path ownership when an IME-delayed attachment is applied. */
  targetOwnerIsCurrent?: () => boolean
}

export function nativeChatWorkspaceAttachmentMismatchNotice(): string {
  return translate(
    'components.native-chat.composer.workspaceAttachmentMismatch',
    'Files can only be attached to their source workspace.'
  )
}

/** Whether an attachment captured against `captured` may still land on `current`.
 *  `not-ready` never matches: an unknown owner is not evidence of the same one. */
export function nativeChatAttachmentOwnerUnchanged(
  captured: NativeChatAttachmentOwner,
  current: NativeChatAttachmentOwner
): boolean {
  if (captured.kind !== current.kind || captured.kind === 'not-ready') {
    return false
  }
  if (captured.kind !== 'ssh' || current.kind !== 'ssh') {
    return true
  }
  return (
    captured.connectionId === current.connectionId &&
    captured.worktreePath === current.worktreePath &&
    captured.expectedExecutionHostId === current.expectedExecutionHostId &&
    captured.expectedSshTargetId === current.expectedSshTargetId &&
    captured.expectedSshConnectionGeneration === current.expectedSshConnectionGeneration
  )
}

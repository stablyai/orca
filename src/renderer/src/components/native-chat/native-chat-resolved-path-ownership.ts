import { resolveContinuedRuntimeEnvironmentRevision } from '@/runtime/runtime-environment-revision'
import { translate } from '@/i18n/i18n'
import type {
  NativeChatAttachmentOwner,
  NativeChatStructuredAttachmentSession
} from './native-chat-attachment-upload'

export type NativeChatAttachmentFocusOptions = { focus?: boolean }

export type NativeChatResolvedPathOperation = {
  apply: (insertReferences: ((paths: string[]) => void) | null) => boolean
  cancel: () => void
}

export type NativeChatResolvedPathOptions = NativeChatAttachmentFocusOptions & {
  operation?: NativeChatResolvedPathOperation
  /** Revalidates the destination without granting workspace-file provenance. */
  destinationIsCurrent?: () => boolean
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
  if (captured.kind === 'runtime-session' && current.kind === 'runtime-session') {
    return (
      captured.environmentId === current.environmentId &&
      captured.sessionId === current.sessionId &&
      resolveContinuedRuntimeEnvironmentRevision(
        captured.environmentId,
        captured.pairingRevision
      ) === current.pairingRevision
    )
  }
  if (captured.kind === 'remote' && current.kind === 'remote') {
    // Why: an image saved on one server is unreadable on another.
    return captured.clipboardImageEnvironmentId === current.clipboardImageEnvironmentId
  }
  return captured.kind === current.kind && captured.kind !== 'not-ready'
}

/** The pane a composer serves; an attach applies only while it still serves the same one. */
export type ComposerWorkspace = {
  structuredWorktreeId?: string
  terminalTabId: string
  structuredSession?: NativeChatStructuredAttachmentSession
}

export function isSameComposerWorkspace(
  captured: ComposerWorkspace,
  current: ComposerWorkspace
): boolean {
  return (
    captured.structuredWorktreeId === current.structuredWorktreeId &&
    captured.terminalTabId === current.terminalTabId &&
    captured.structuredSession?.sessionId === current.structuredSession?.sessionId &&
    captured.structuredSession?.runtimeEnvironmentId ===
      current.structuredSession?.runtimeEnvironmentId
  )
}

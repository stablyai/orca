import { translate } from '@/i18n/i18n'
import { setNativeChatPasteFailure } from './native-chat-composer-notice'
import {
  nativeChatLocalAttachmentUnsupportedNotice,
  prepareNativeChatSessionAttachmentUpload,
  type NativeChatAttachmentOwner
} from './native-chat-attachment-upload'

type ClipboardImageOwner = Extract<
  NativeChatAttachmentOwner,
  { kind: 'local' | 'ssh' | 'runtime-session' }
>

/** Owners whose attachment path is a file this client can write right now. */
export function ownerAcceptsClipboardImage(
  owner: NativeChatAttachmentOwner
): owner is ClipboardImageOwner {
  return owner.kind === 'local' || owner.kind === 'ssh' || owner.kind === 'runtime-session'
}

/** Where the clipboard image is saved: this machine, the SSH host, or the chat's store on its
 *  paired server, after asking that server whether it keeps one. */
async function clipboardImageSaveArgs(
  owner: ClipboardImageOwner
): Promise<
  | { ok: true; args: Parameters<typeof window.api.ui.saveClipboardImageAsTempFile>[0] }
  | { ok: false; notice: string; cause: NativeChatClipboardImageFailureCause }
> {
  if (owner.kind === 'local') {
    return { ok: true, args: { forNativeChatDraft: true } }
  }
  if (owner.kind === 'ssh') {
    return { ok: true, args: { connectionId: owner.connectionId } }
  }
  const prepared = await prepareNativeChatSessionAttachmentUpload(owner)
  if (!prepared.ok) {
    return { ...prepared, cause: 'serverTooOld' }
  }
  const { environmentId, ...agentSessionAttachment } = prepared.target
  return { ok: true, args: { runtimeEnvironmentId: environmentId, agentSessionAttachment } }
}

/** `serverTooOld`: the chat's paired server keeps no attachments, so it could never take one. */
export type NativeChatClipboardImageFailureCause = 'serverTooOld' | 'failed'

/** Save the clipboard image where the owner's agent can read it. Every failure is reported. */
export async function saveNativeChatClipboardImage(
  owner: NativeChatAttachmentOwner,
  report: {
    /** `errorText`: the failure's own words, kept apart from Orca's notice. */
    setNotice: (
      notice: string,
      cause: NativeChatClipboardImageFailureCause,
      errorText?: string
    ) => void
    /** The image has somewhere to go, now that any server it goes to has said it takes one. */
    ready?: () => void
  }
): Promise<{ status: 'saved'; tempPath: string } | { status: 'empty' | 'failed' }> {
  if (!ownerAcceptsClipboardImage(owner)) {
    report.setNotice(nativeChatLocalAttachmentUnsupportedNotice(), 'failed')
    return { status: 'failed' }
  }
  try {
    // SSH panes save the image on the remote host (SFTP) so the attached
    // path is readable by the remote agent, matching terminal image paste.
    const target = await clipboardImageSaveArgs(owner)
    if (!target.ok) {
      report.setNotice(target.notice, target.cause)
      return { status: 'failed' }
    }
    report.ready?.()
    const tempPath = await window.api.ui.saveClipboardImageAsTempFile(target.args)
    return tempPath ? { status: 'saved', tempPath } : { status: 'empty' }
  } catch (error) {
    // A failed save must be visible: over SSH it fails whenever the
    // connection drops, and a silent no-op reads as a broken paste.
    setNativeChatPasteFailure(
      (notice, errorText) => {
        if (notice !== null) {
          report.setNotice(notice, 'failed', errorText)
        }
      },
      error,
      translate('components.native-chat.composer.imagePasteFailed', 'Image paste failed.')
    )
    return { status: 'failed' }
  }
}

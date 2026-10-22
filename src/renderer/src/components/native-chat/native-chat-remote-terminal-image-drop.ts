import { basename } from '@/lib/path'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { isNativeChatImageAttachmentPath } from './native-chat-image-paste'
import type { NativeChatAttachmentFocusOptions } from './native-chat-resolved-path-ownership'
import {
  nativeChatAttachFailedNotice,
  nativeChatAttachmentOwnerChangedNotice,
  nativeChatLocalAttachmentUnsupportedNotice,
  type NativeChatAttachmentOwner
} from './native-chat-attachment-upload'
import type {
  NativeChatPendingAttachmentChips,
  NativeChatReservedAttachment
} from './native-chat-session-attachment-drop'

/**
 * Null when a remote terminal intake admits the batch: its agent runs on the
 * paired server's own host, and every path is an image, so the bytes upload
 * into that host's temp dir like a remote clipboard paste. Anything else keeps
 * the unsupported refusal.
 */
export function refuseRemoteTerminalImageDrop(
  owner: Extract<NativeChatAttachmentOwner, { kind: 'remote' }>,
  count: number,
  paths: readonly string[]
): string | null {
  const uploads =
    owner.clipboardImageEnvironmentId !== undefined &&
    count > 0 &&
    paths.every(isNativeChatImageAttachmentPath)
  return uploads ? null : nativeChatLocalAttachmentUnsupportedNotice()
}

export type AttachNativeChatRemoteTerminalImagesArgs = {
  pending: NativeChatReservedAttachment[]
  runtimeEnvironmentId: string
  chips: NativeChatPendingAttachmentChips
  options?: NativeChatAttachmentFocusOptions
  isAbandoned: () => boolean
  ownerStillCurrent: () => boolean
  setNotice: (notice: string | null) => void
}

/**
 * A terminal-backed chat on a paired server: dropped image bytes upload into
 * the server's own temp dir (the same pipeline a remote clipboard paste uses),
 * and the chips settle to the remote paths the agent reads. Failures name
 * their files; nothing is inserted as a local path the agent cannot read.
 */
export async function attachNativeChatRemoteTerminalImages(
  args: AttachNativeChatRemoteTerminalImagesArgs
): Promise<void> {
  const {
    pending,
    runtimeEnvironmentId,
    chips,
    options,
    isAbandoned,
    ownerStillCurrent,
    setNotice
  } = args
  const dropAll = (): void => {
    for (const { chipId } of pending) {
      chips.drop(chipId)
    }
  }
  const checkAbandoned = (): boolean => {
    if (isAbandoned()) {
      dropAll()
      return true
    }
    if (!ownerStillCurrent()) {
      dropAll()
      setNotice(nativeChatAttachmentOwnerChangedNotice())
      return true
    }
    return false
  }
  const stored = new Map<string, string>()
  const reasons = new Map<string, string>()
  for (const { path } of pending) {
    if (checkAbandoned()) {
      return
    }
    try {
      stored.set(
        path,
        await window.api.ui.saveImageFileAsTempFile({ filePath: path, runtimeEnvironmentId })
      )
    } catch (error) {
      reasons.set(path, extractIpcErrorMessage(error, ''))
    }
  }
  if (checkAbandoned()) {
    return
  }
  const notAttached: { name: string; reason: string }[] = []
  for (const { path, chipId } of pending) {
    const storedPath = stored.get(path)
    if (!storedPath) {
      if (chips.drop(chipId)) {
        notAttached.push({ name: basename(path), reason: reasons.get(path) ?? '' })
      }
      continue
    }
    chips.resolve(chipId, storedPath, null, options)
  }
  if (notAttached.length > 0) {
    const [first] = notAttached
    const shared = notAttached.every(({ reason }) => reason === first?.reason)
      ? (first?.reason ?? '')
      : ''
    setNotice(
      nativeChatAttachFailedNotice(
        notAttached.map(({ name }) => name),
        shared
      )
    )
  }
}

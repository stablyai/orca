import { basename } from '@/lib/path'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { describeDropSkipReason } from '@/lib/drop-skip-reason-copy'
import { isNativeChatImageAttachmentPath } from './native-chat-image-paste'
import type { NativeChatAttachmentFocusOptions } from './native-chat-resolved-path-ownership'
import {
  nativeChatAttachFailedNotice,
  nativeChatAttachmentOwnerChangedNotice,
  prepareNativeChatSessionAttachmentUpload,
  uploadNativeChatSessionAttachmentPaths,
  type NativeChatRuntimeSessionAttachmentOwner
} from './native-chat-attachment-upload'

export type NativeChatPendingAttachmentOptions = NativeChatAttachmentFocusOptions & {
  insertReferences?: ((paths: string[]) => void) | null
}

/** The composer's pending-chip controls, as an upload drives them. */
export type NativeChatPendingAttachmentChips = {
  begin: (previewUrl?: string, pendingName?: string) => string | null
  resolve: (
    id: string,
    path: string,
    connectionId?: string | null,
    options?: NativeChatPendingAttachmentOptions
  ) => boolean
  /** Removes the chip; false when the user already removed it, so its file must not attach. */
  drop: (id: string) => boolean
  /** Adds stored files as `@path` references to the scope's draft, which keeps them through an
   *  input-method composition or a remount. */
  attachReferences: (
    references: { id: string; path: string }[],
    options?: NativeChatPendingAttachmentOptions
  ) => boolean
}

/** A file and the pending chip reserved for it, which alone may settle its result. */
export type NativeChatReservedAttachment = { path: string; chipId: string }

/** One named pending chip per file; a path without one was refused and the composer said why. */
export function reserveNativeChatAttachmentChips(
  chips: NativeChatPendingAttachmentChips,
  paths: string[]
): NativeChatReservedAttachment[] {
  return paths.flatMap((path) => {
    const chipId = chips.begin(undefined, basename(path))
    return chipId ? [{ path, chipId }] : []
  })
}

/**
 * Drop or pick files into a structured chat on a paired server: upload them into the chat's store
 * there, then attach the stored paths. Each file shows as a pending chip with its name at once, and
 * Send waits for pending chips, so a message never leaves without a file the user attached. A chip
 * the user removes meanwhile attaches nothing.
 */
export async function attachNativeChatSessionAttachmentPaths(args: {
  pending: NativeChatReservedAttachment[]
  owner: NativeChatRuntimeSessionAttachmentOwner
  chips: NativeChatPendingAttachmentChips
  options?: NativeChatAttachmentFocusOptions
  /** The composer was disabled or torn down meanwhile. */
  isAbandoned: () => boolean
  ownerStillCurrent: () => boolean
  setNotice: (notice: string | null) => void
}): Promise<void> {
  const { pending } = args
  if (pending.length === 0) {
    return
  }
  const dropAll = (): void => {
    for (const { chipId } of pending) {
      args.chips.drop(chipId)
    }
  }
  let stored: Map<string, string>
  let reasons: Map<string, string>
  try {
    const prepared = await prepareNativeChatSessionAttachmentUpload(args.owner)
    if (!prepared.ok) {
      dropAll()
      args.setNotice(prepared.notice)
      return
    }
    const result = await uploadNativeChatSessionAttachmentPaths(
      pending.map(({ path }) => path),
      prepared.target
    )
    stored = new Map(result.uploaded.map(({ sourcePath, path }) => [sourcePath, path]))
    reasons = new Map([
      ...result.skipped.map(({ sourcePath, reason }): [string, string] => [
        sourcePath,
        describeDropSkipReason(reason) ?? reason
      ]),
      ...result.failed.map(({ sourcePath, reason }): [string, string] => [sourcePath, reason])
    ])
  } catch (error) {
    // Every file failed for the same cause.
    stored = new Map()
    const cause = extractIpcErrorMessage(error, '')
    reasons = new Map(pending.map(({ path }) => [path, cause]))
  }
  if (args.isAbandoned()) {
    dropAll()
    return
  }
  if (!args.ownerStillCurrent()) {
    dropAll()
    args.setNotice(nativeChatAttachmentOwnerChangedNotice())
    return
  }
  const notAttached: { name: string; reason: string }[] = []
  const references: { id: string; path: string }[] = []
  for (const { path, chipId } of pending) {
    const storedPath = stored.get(path)
    if (!storedPath) {
      if (args.chips.drop(chipId)) {
        notAttached.push({ name: basename(path), reason: reasons.get(path) ?? '' })
      }
      continue
    }
    if (isNativeChatImageAttachmentPath(storedPath)) {
      args.chips.resolve(chipId, storedPath, null, args.options)
      continue
    }
    // Other files become `@path` references, as every attach does, unless their chip was removed.
    references.push({ id: chipId, path: storedPath })
  }
  // Inserting at the caret clears the notice, so what failed is said after.
  if (references.length > 0) {
    args.chips.attachReferences(references, args.options)
  }
  if (notAttached.length > 0) {
    // A cause every file shares is said once, after their names.
    const [first] = notAttached
    const shared = notAttached.every(({ reason }) => reason === first?.reason) ? first?.reason : ''
    args.setNotice(
      nativeChatAttachFailedNotice(
        notAttached.map(({ name }) => name),
        shared
      )
    )
  }
}

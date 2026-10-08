import { basename } from '@/lib/path'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { describeDropSkipReason } from '@/lib/drop-skip-reason-copy'
import { isNativeChatImageAttachmentPath } from './native-chat-image-paste'
import {
  nativeChatAttachFailedNotice,
  nativeChatAttachmentOwnerChangedNotice,
  prepareNativeChatSessionAttachmentUpload,
  uploadNativeChatSessionAttachmentPaths,
  type NativeChatRuntimeSessionAttachmentOwner
} from './native-chat-attachment-upload'

/** The composer's pending-chip controls, as an upload drives them. */
export type NativeChatPendingAttachmentChips = {
  begin: (previewUrl?: string, pendingName?: string) => string | null
  resolve: (id: string, path: string, connectionId?: string | null) => void
  /** Removes the chip; false when the user already removed it, so its file must not attach. */
  drop: (id: string) => boolean
  /** Adds stored files as `@path` references to the scope's draft, which keeps them through an
   *  input-method composition or a remount. */
  attachReferences: (paths: string[]) => void
}

/**
 * Drop or pick files into a structured chat on a paired server: upload them into the chat's store
 * there, then attach the stored paths. Each file shows as a pending chip with its name at once, and
 * Send waits for pending chips, so a message never leaves without a file the user attached. A chip
 * the user removes meanwhile attaches nothing.
 */
export async function attachNativeChatSessionAttachmentPaths(args: {
  paths: string[]
  owner: NativeChatRuntimeSessionAttachmentOwner
  chips: NativeChatPendingAttachmentChips
  /** The composer was disabled or torn down meanwhile. */
  isAbandoned: () => boolean
  ownerStillCurrent: () => boolean
  setNotice: (notice: string | null) => void
}): Promise<void> {
  const pending = args.paths.flatMap((path) => {
    const chipId = args.chips.begin(undefined, basename(path))
    // No chip: the composer refused the attach and already said why.
    return chipId ? [{ path, chipId }] : []
  })
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
  const references: string[] = []
  for (const { path, chipId } of pending) {
    const storedPath = stored.get(path)
    if (!storedPath) {
      if (args.chips.drop(chipId)) {
        notAttached.push({ name: basename(path), reason: reasons.get(path) ?? '' })
      }
      continue
    }
    if (isNativeChatImageAttachmentPath(storedPath)) {
      args.chips.resolve(chipId, storedPath, null)
      continue
    }
    // Other files become `@path` references, as every attach does, unless their chip was removed.
    if (args.chips.drop(chipId)) {
      references.push(storedPath)
    }
  }
  // Inserting at the caret clears the notice, so what failed is said after.
  if (references.length > 0) {
    args.chips.attachReferences(references)
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

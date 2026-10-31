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
  /** Persist @path references in the draft through IME composition and remounts. */
  attachReferences: (
    references: { id: string; path: string }[],
    options?: NativeChatPendingAttachmentOptions
  ) => boolean
}

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

/** Upload paired-server files behind pending chips; Send waits, and removed chips must never attach. */
export async function attachNativeChatSessionAttachmentPaths(args: {
  pending: NativeChatReservedAttachment[]
  owner: NativeChatRuntimeSessionAttachmentOwner
  chips: NativeChatPendingAttachmentChips
  options?: NativeChatAttachmentFocusOptions
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
    references.push({ id: chipId, path: storedPath })
  }
  // Insertions clear notices, so report failures afterward.
  if (references.length > 0) {
    args.chips.attachReferences(references, args.options)
  }
  if (notAttached.length > 0) {
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

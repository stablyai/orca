import { basename } from '@/lib/path'
import { extractIpcErrorMessage } from '@/runtime/errors/ipc-error'
import { describeDropSkipReason } from '@/lib/files/drop/drop-skip-reason-copy'
import { isAgentInlineImagePath } from '../../../../../../shared/agent-inline-image-types'
import type { NativeChatAttachmentFocusOptions } from '../uploads/native-chat-resolved-path-ownership'
import {
  nativeChatAttachFailedNotice,
  nativeChatAttachmentOwnerChangedNotice
} from './native-chat-attachment-notices'
import {
  prepareNativeChatSessionAttachmentUpload,
  uploadNativeChatSessionAttachmentPaths
} from '../uploads/native-chat-session-attachment-upload'
import type { NativeChatRuntimeSessionAttachmentOwner } from '../uploads/native-chat-attachment-owner'
import type { AgentSessionAttachmentPathUploadResult } from '../../../../../../shared/agent-session/agent-session-attachments'

export type NativeChatPendingAttachmentOptions = NativeChatAttachmentFocusOptions & {
  insertReferences?: ((paths: string[]) => void) | null
}

export type NativeChatPendingAttachmentChips = {
  /** `serverOwned`: the file will live on the remote target, so a remote terminal may take it. */
  begin: (previewUrl?: string, pendingName?: string, serverOwned?: boolean) => string | null
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
    options?: NativeChatPendingAttachmentOptions,
    serverOwned?: boolean
  ) => boolean
}

export type NativeChatReservedAttachment = { path: string; chipId: string }

/** One named pending chip per file; a path without one was refused and the composer said why. */
export function reserveNativeChatAttachmentChips(
  chips: NativeChatPendingAttachmentChips,
  paths: string[],
  serverOwned = false
): NativeChatReservedAttachment[] {
  return paths.flatMap((path) => {
    const chipId = chips.begin(undefined, basename(path), serverOwned)
    return chipId ? [{ path, chipId }] : []
  })
}

/** Uploads client paths and reports where each one landed, or a notice when nothing can be sent. */
type NativeChatAttachmentPathUpload = (
  paths: string[]
) => Promise<
  { ok: true; result: AgentSessionAttachmentPathUploadResult } | { ok: false; notice: string }
>

/** Upload paired-server files behind pending chips; Send waits, and removed chips must never attach. */
export function attachNativeChatSessionAttachmentPaths(args: {
  pending: NativeChatReservedAttachment[]
  owner: NativeChatRuntimeSessionAttachmentOwner
  chips: NativeChatPendingAttachmentChips
  options?: NativeChatAttachmentFocusOptions
  isAbandoned: () => boolean
  ownerStillCurrent: () => boolean
  setNotice: (notice: string | null) => void
}): Promise<void> {
  const { owner, ...rest } = args
  return attachNativeChatUploadedPaths({
    ...rest,
    upload: async (paths) => {
      const prepared = await prepareNativeChatSessionAttachmentUpload(owner)
      return prepared.ok
        ? { ok: true, result: await uploadNativeChatSessionAttachmentPaths(paths, prepared.target) }
        : prepared
    }
  })
}

/** Upload client files to the server's temp folder for a terminal-backed chat running there. */
export function attachNativeChatRuntimeTempPaths(args: {
  pending: NativeChatReservedAttachment[]
  environmentId: string
  chips: NativeChatPendingAttachmentChips
  options?: NativeChatAttachmentFocusOptions
  isAbandoned: () => boolean
  ownerStillCurrent: () => boolean
  setNotice: (notice: string | null) => void
}): Promise<void> {
  const { environmentId, ...rest } = args
  return attachNativeChatUploadedPaths({
    ...rest,
    serverOwned: true,
    upload: async (paths) => ({
      ok: true,
      result: await window.api.fs.uploadPathsToRuntimeTempFiles({ environmentId, paths })
    })
  })
}

/** Upload reserved files, then settle each chip: images as images, other files as path references. */
async function attachNativeChatUploadedPaths(args: {
  pending: NativeChatReservedAttachment[]
  upload: NativeChatAttachmentPathUpload
  serverOwned?: boolean
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
    const uploaded = await args.upload(pending.map(({ path }) => path))
    if (!uploaded.ok) {
      dropAll()
      args.setNotice(uploaded.notice)
      return
    }
    const { result } = uploaded
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
    if (isAgentInlineImagePath(storedPath)) {
      args.chips.resolve(chipId, storedPath, null, args.options)
      continue
    }
    references.push({ id: chipId, path: storedPath })
  }
  // Insertions clear notices, so report failures afterward.
  if (references.length > 0) {
    if (args.serverOwned) {
      args.chips.attachReferences(references, args.options, true)
    } else {
      args.chips.attachReferences(references, args.options)
    }
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

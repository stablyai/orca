import { basename } from '@/lib/path'
import { extractIpcErrorMessage } from '@/runtime/errors/ipc-error'
import { describeDropSkipReason } from '@/lib/files/drop/drop-skip-reason-copy'
import { isAgentInlineImagePath } from '../../../../../../shared/native-chat/input/composer/agent-inline-image-types'
import type { NativeChatAttachmentFocusOptions } from '../uploads/native-chat-resolved-path-ownership'
import {
  nativeChatAttachFailedNotice,
  nativeChatAttachmentOwnerChangedNotice,
  nativeChatWorktreeNotReadyNotice
} from './native-chat-attachment-notices'
import {
  prepareNativeChatSessionAttachmentUpload,
  uploadNativeChatSessionAttachmentPaths
} from '../uploads/native-chat-session-attachment-upload'
import {
  resolveNativeChatAgentStagingTarget,
  type NativeChatAttachmentStagingOwner,
  type NativeChatRuntimeSessionAttachmentOwner
} from '../uploads/native-chat-attachment-owner'
import { stageClientFilesForAgent } from '@/runtime/files/imports/agent-file-staging'

export type NativeChatPendingAttachmentOptions = NativeChatAttachmentFocusOptions & {
  insertReferences?: ((paths: string[]) => void) | null
  clipboardImage?: { stagingScope?: string }
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
    options?: NativeChatPendingAttachmentOptions
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

type NativeChatAttachmentUploadResult = {
  uploaded: { sourcePath: string; path: string }[]
  skipped: { sourcePath: string; reason: string }[]
  failed: { sourcePath: string; reason: string }[]
}

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
        ? { ok: true, ...(await uploadNativeChatSessionAttachmentPaths(paths, prepared.target)) }
        : prepared
    }
  })
}

/** Stage client files where a terminal-backed remote chat's agent runs, as a terminal drop does. */
export function attachNativeChatStagedAgentPaths(args: {
  pending: NativeChatReservedAttachment[]
  staging: NativeChatAttachmentStagingOwner
  chips: NativeChatPendingAttachmentChips
  options?: NativeChatAttachmentFocusOptions
  isAbandoned: () => boolean
  ownerStillCurrent: () => boolean
  setNotice: (notice: string | null) => void
}): Promise<void> {
  const { staging, ...rest } = args
  return attachNativeChatUploadedPaths({
    ...rest,
    upload: async (paths) => {
      const target = resolveNativeChatAgentStagingTarget(staging)
      if (!target) {
        return { ok: false, notice: nativeChatWorktreeNotReadyNotice() }
      }
      // Stop between files once the chat leaves this host, as a terminal drop does.
      const result = await stageClientFilesForAgent(target, paths, () => {
        if (!rest.ownerStillCurrent()) {
          throw new Error(nativeChatAttachmentOwnerChangedNotice())
        }
      })
      return {
        ok: true,
        uploaded: result.staged.map(({ sourcePath, hostPath }) => ({ sourcePath, path: hostPath })),
        skipped: result.skipped,
        failed: result.failed
      }
    }
  })
}

async function attachNativeChatUploadedPaths(args: {
  pending: NativeChatReservedAttachment[]
  upload: (
    paths: string[]
  ) => Promise<({ ok: true } & NativeChatAttachmentUploadResult) | { ok: false; notice: string }>
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
    const result = await args.upload(pending.map(({ path }) => path))
    if (!result.ok) {
      dropAll()
      args.setNotice(result.notice)
      return
    }
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

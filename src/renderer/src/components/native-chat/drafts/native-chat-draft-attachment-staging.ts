import {
  hasNativeChatPendingAttachment,
  nativeChatPendingAttachmentScope
} from '../attachments/chips/native-chat-pending-attachment-scopes'
import { nativeChatTextAttachmentParts } from '../../../../../shared/native-chat/attachments/native-chat-text-attachment-references'
import type { NativeChatComposerDraft } from './native-chat-composer-draft-storage'
import { releaseBrowserAttachmentFiles } from '@/lib/files/drop/browser-attachment-files'
import {
  updateDraftHolders,
  retireNativeChatStagedLeases,
  nativeChatStagedDraftReferences
} from './native-chat-staged-ownership'

export type NativeChatStagedInput = {
  text: string
  attachments?: readonly { path: string }[]
}

export type StagedFiles = {
  scope: string
  paths: Set<string>
  draftPaths: Set<string>
  heldInputs: Set<Set<string>>
  leases: Set<Set<string>>
  /** Send leases to drop once the draft holds each file, itself or through a live upload of it. */
  pendingLeases: Set<Set<string>>
  draft?: NativeChatComposerDraft
  referenceText?: string
  textReferences: Set<string>
  movedTo?: StagedFiles
  uploads: Map<string, Map<string, Promise<string>>>
  /** Host path of each finished upload → its record (see `NativeChatStagedUpload`). */
  uploaded: Map<string, NativeChatStagedUpload>
}
const staged = new Map<string, StagedFiles>()

export function stagedNativeChatFiles(scope: string): StagedFiles | undefined {
  return staged.get(scope)
}

/** Scopes holding staged files, recorded draft or not: deliberate teardown must reach them too. */
/**
 * One finished upload of a staged original: the upload target it went to (cache key), the original,
 * the conversation it was made for, and the cached upload that produced it.
 */
export type NativeChatStagedUpload = {
  target: string
  source: string
  sessionId: string
  upload: Promise<string>
}

/** Every live staging owner once, however many scopes or moves lead to it. */
export function nativeChatStagedFileOwners(): StagedFiles[] {
  return [...new Set([...staged.values()].map(currentFiles))]
}

/**
 * Hand one staged original, with its upload records and cached uploads, to another draft, which becomes
 * its only owner: it leaves the old owner's files, leases and holds, so neither owner can release it for
 * the other.
 */
export function adoptNativeChatStagedFile(from: StagedFiles, path: string, toScope: string): void {
  const current = staged.get(toScope)
  if (current && currentFiles(current) === from) {
    return
  }
  stageNativeChatDraftFile(toScope, path)
  const owner = currentFiles(staged.get(toScope)!)
  for (const [host, origin] of from.uploaded) {
    if (origin.source === path) {
      owner.uploaded.set(host, origin)
      from.uploaded.delete(host)
    }
  }
  for (const [target, uploads] of from.uploads) {
    const upload = uploads.get(path)
    if (upload) {
      uploads.delete(path)
      const into = owner.uploads.get(target) ?? new Map<string, Promise<string>>()
      into.set(path, into.get(path) ?? upload)
      owner.uploads.set(target, into)
    }
  }
  updateDraftHolders(from.scope, new Set([path]), new Set())
  from.paths.delete(path)
  from.draftPaths.delete(path)
  from.textReferences.delete(path)
  for (const held of [...from.leases, ...from.heldInputs, ...from.pendingLeases]) {
    held.delete(path)
  }
  if (!from.paths.size) {
    for (const [scope, held] of staged) {
      if (held === from) {
        staged.delete(scope)
      }
    }
  }
}

/**
 * The draft scopes whose draft holds this original now, after any move or adoption: its draft
 * references it. A send's lease alone keeps an original readable but makes no chat its owner.
 */
export { nativeChatStagedFileDraftHolderScopes } from './native-chat-staged-ownership'

export function nativeChatStagedScopes(): string[] {
  return [...staged.keys()]
}

export function currentFiles(files: StagedFiles): StagedFiles {
  return files.movedTo ? currentFiles(files.movedTo) : files
}

export function inputPaths(files: StagedFiles, input: NativeChatStagedInput): string[] {
  return namedNativeChatStagedPaths(files.paths, input)
}

/** Which of `paths` the input names, as an attached image or a text reference. */
export function namedNativeChatStagedPaths(
  paths: ReadonlySet<string>,
  input: NativeChatStagedInput
): string[] {
  // Indexed once, so the work is linear in the paths, attachments and text: O(P + A + T).
  const named = new Set(input.attachments?.map((image) => image.path))
  for (const part of nativeChatTextAttachmentParts(input.text, true, (path) => paths.has(path))) {
    if (part.path) {
      named.add(part.path)
    }
  }
  return [...paths].filter((path) => named.has(path))
}

export function hasNativeChatStagedFiles(scope: string): boolean {
  return (staged.get(scope)?.paths.size ?? 0) > 0
}

export function stageNativeChatDraftFile(scope: string, path: string): void {
  let files = staged.get(scope)
  if (!files) {
    files = {
      scope,
      paths: new Set(),
      draftPaths: new Set(),
      heldInputs: new Set(),
      leases: new Set(),
      pendingLeases: new Set(),
      textReferences: new Set(),
      uploads: new Map(),
      uploaded: new Map()
    }
    staged.set(scope, files)
  }
  files.paths.add(path)
  updateDraftHolders(scope, files.draftPaths, new Set([...files.draftPaths, path]))
  files.draftPaths.add(path)
}

export function moveNativeChatStagedFiles(from: string, to: string): void {
  if (from === to) {
    return
  }
  const files = staged.get(from)
  if (!files) {
    return
  }
  const existing = staged.get(to)
  updateDraftHolders(from, files.draftPaths, new Set())
  updateDraftHolders(
    to,
    existing?.draftPaths ?? new Set(),
    new Set([...files.draftPaths, ...(existing?.draftPaths ?? [])])
  )
  files.scope = to
  if (existing) {
    existing.paths.forEach((path) => files.paths.add(path))
    existing.draftPaths.forEach((path) => files.draftPaths.add(path))
    existing.leases.forEach((lease) => files.leases.add(lease))
    existing.pendingLeases.forEach((lease) => files.pendingLeases.add(lease))
    existing.heldInputs.forEach((held) => files.heldInputs.add(held))
    existing.uploaded.forEach((origin, host) => files.uploaded.set(host, origin))
    for (const [target, uploads] of existing.uploads) {
      const held = files.uploads.get(target) ?? new Map<string, Promise<string>>()
      uploads.forEach((upload, path) => held.set(path, held.get(path) ?? upload))
      files.uploads.set(target, held)
    }
    existing.movedTo = files
  }
  staged.set(to, files)
  staged.delete(from)
  files.draft = undefined
}

/** The draft keeps this original readable itself, or holds a live host upload made from it. */
export function nativeChatStagedFileHeld(
  files: StagedFiles,
  path: string,
  referenced = nativeChatStagedDraftReferences(files)
): boolean {
  return (
    files.draftPaths.has(path) ||
    [...files.uploaded].some(([host, origin]) => origin.source === path && referenced.has(host))
  )
}

/** A send lease waiting for custody ends once the draft holds every file it covers. */
function releaseHeldLeases(files: StagedFiles): void {
  const referenced = nativeChatStagedDraftReferences(files)
  for (const lease of files.pendingLeases) {
    if ([...lease].every((path) => nativeChatStagedFileHeld(files, path, referenced))) {
      files.pendingLeases.delete(lease)
      files.leases.delete(lease)
      files.heldInputs.delete(lease)
    }
  }
}

export function pruneFiles(files: StagedFiles): void {
  releaseHeldLeases(files)
  const retained = new Set([
    ...files.draftPaths,
    ...[...files.heldInputs].flatMap((held) => [...held]),
    ...[...files.leases].flatMap((lease) => [...lease])
  ])
  releaseFiles(
    files,
    [...files.paths].filter((path) => !retained.has(path))
  )
}

/** Draft edits release removed files; accepted sends keep their own leases until settlement. */
export function reconcileNativeChatStagedDraft(
  scope: string,
  draft?: NativeChatComposerDraft
): void {
  const files = staged.get(scope)
  if (!files || files.draft === draft) {
    return
  }
  const previous = files.draft
  files.draft = draft
  if (
    previous &&
    draft &&
    previous.text === draft.text &&
    previous.images === draft.images &&
    previous.pastedTextFiles === draft.pastedTextFiles
  ) {
    return
  }
  if (files.referenceText !== draft?.text) {
    files.referenceText = draft?.text
    files.textReferences = new Set(
      nativeChatTextAttachmentParts(draft?.text ?? '', true, () => true).flatMap((part) =>
        part.path ? [part.path] : []
      )
    )
  }
  const images = new Set(draft?.images.map(({ path }) => path))
  const pasted = new Set(Object.values(draft?.pastedTextFiles ?? {}))
  const draftPaths = new Set(
    [...files.paths].filter((path) => {
      if (images.has(path) || pasted.has(path)) {
        return true
      }
      return files.textReferences.has(path)
    })
  )
  updateDraftHolders(scope, files.draftPaths, draftPaths)
  files.draftPaths = draftPaths
  pruneFiles(files)
}

export function holdNativeChatStagedInput(scope: string, input: NativeChatStagedInput): void {
  const files = staged.get(scope)
  if (files) {
    files.heldInputs.clear()
    files.heldInputs.add(new Set(inputPaths(files, input)))
    pruneFiles(files)
  }
}

function releaseFiles(files: StagedFiles, paths: string[]): void {
  updateDraftHolders(
    files.scope,
    new Set(paths.filter((path) => files.draftPaths.has(path))),
    new Set()
  )
  releaseBrowserAttachmentFiles(paths)
  for (const path of paths) {
    files.paths.delete(path)
    files.draftPaths.delete(path)
    files.textReferences.delete(path)
    files.uploads.forEach((uploads) => uploads.delete(path))
    files.uploaded.forEach((origin, host) => origin.source === path && files.uploaded.delete(host))
  }
  if (!files.paths.size) {
    for (const [scope, held] of staged) {
      if (held === files) {
        staged.delete(scope)
      }
    }
  }
}

export function releaseNativeChatStagedFiles(scope: string): void {
  const files = staged.get(scope)
  if (files) {
    retireNativeChatStagedLeases(files.leases)
    releaseFiles(files, [...files.paths])
  }
}

/**
 * No send will hand these files back any more (the recipient chat was discarded before it existed): stop
 * waiting for custody and keep only what a recorded draft still references.
 */
export function abandonNativeChatPendingStagedLeases(scope: string): void {
  const files = staged.get(scope)
  if (!files) {
    return
  }
  retireNativeChatStagedLeases(files.leases)
  for (const lease of files.pendingLeases) {
    files.leases.delete(lease)
    files.heldInputs.delete(lease)
  }
  files.pendingLeases.clear()
  if (!files.draft) {
    updateDraftHolders(scope, files.draftPaths, new Set())
    files.draftPaths.clear()
  }
  pruneFiles(files)
}

export function stageNativeChatPendingImage(
  scope: string,
  id: string | null,
  path: string
): boolean {
  if (!id || !hasNativeChatPendingAttachment(id)) {
    releaseBrowserAttachmentFiles([path])
    return false
  }
  stageNativeChatDraftFile(nativeChatPendingAttachmentScope(scope, id), path)
  return true
}

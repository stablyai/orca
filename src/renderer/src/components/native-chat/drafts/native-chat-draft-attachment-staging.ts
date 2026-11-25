import {
  hasNativeChatPendingAttachment,
  nativeChatPendingAttachmentScope
} from '../attachments/chips/native-chat-pending-attachment-scopes'
import { nativeChatTextAttachmentParts } from '../../../../../shared/native-chat/attachments/native-chat-text-attachment-references'
import type { NativeChatComposerDraft } from './native-chat-composer-draft-storage'
import { releaseBrowserAttachmentFiles } from '@/lib/files/drop/browser-attachment-files'

export type NativeChatStagedInput = {
  text: string
  attachments?: readonly { path: string }[]
}

export type StagedFiles = {
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
  /** Host path of each finished upload → its upload target and the staged original it came from. */
  uploaded: Map<string, { target: string; source: string }>
}
const staged = new Map<string, StagedFiles>()

export function stagedNativeChatFiles(scope: string): StagedFiles | undefined {
  return staged.get(scope)
}

/** Scopes holding staged files, recorded draft or not: deliberate teardown must reach them too. */
export function nativeChatStagedScopes(): string[] {
  return [...staged.keys()]
}

export function currentFiles(files: StagedFiles): StagedFiles {
  return files.movedTo ? currentFiles(files.movedTo) : files
}

export function inputPaths(files: StagedFiles, input: NativeChatStagedInput): string[] {
  const referenced = new Set(
    nativeChatTextAttachmentParts(input.text, true, (path) => files.paths.has(path)).flatMap(
      (part) => (part.path ? [part.path] : [])
    )
  )
  return [...files.paths].filter(
    (path) => input.attachments?.some((image) => image.path === path) || referenced.has(path)
  )
}

export function hasNativeChatStagedFiles(scope: string): boolean {
  return (staged.get(scope)?.paths.size ?? 0) > 0
}

export function stageNativeChatDraftFile(scope: string, path: string): void {
  let files = staged.get(scope)
  if (!files) {
    files = {
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

function draftReferences(files: StagedFiles): Set<string> {
  const draft = files.draft
  return new Set([
    ...(draft?.images.map(({ path }) => path) ?? []),
    ...Object.values(draft?.pastedTextFiles ?? {}),
    ...files.textReferences
  ])
}

/** The draft keeps this original readable itself, or holds a live host upload made from it. */
export function nativeChatStagedFileHeld(
  files: StagedFiles,
  path: string,
  referenced = draftReferences(files)
): boolean {
  return (
    files.draftPaths.has(path) ||
    [...files.uploaded].some(([host, origin]) => origin.source === path && referenced.has(host))
  )
}

/** A send lease waiting for custody ends once the draft holds every file it covers. */
function releaseHeldLeases(files: StagedFiles): void {
  const referenced = draftReferences(files)
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
  files.draftPaths = new Set(
    [...files.paths].filter((path) => {
      if (images.has(path) || pasted.has(path)) {
        return true
      }
      return files.textReferences.has(path)
    })
  )
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
    releaseFiles(files, [...files.paths])
  }
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

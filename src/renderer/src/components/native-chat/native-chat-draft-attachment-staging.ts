import {
  hasNativeChatPendingAttachment,
  nativeChatPendingAttachmentScope,
  nativeChatPendingAttachmentSnapshot
} from './native-chat-pending-attachment-cache'
import { prepareNativeChatStagedUpload } from './native-chat-staged-upload'
import { nativeChatTextAttachmentParts } from '../../../../shared/native-chat-text-attachment-references'
import type { NativeChatComposerDraft } from './native-chat-composer-draft-storage'
import { releaseBrowserAttachmentFiles } from '@/lib/browser-attachment-files'

export type NativeChatStagedInput = {
  text: string
  attachments?: readonly { path: string }[]
}

export type StagedFiles = {
  scope: string
  paths: Set<string>
  resources: Map<string, object>
  pending: Map<object, string>
  draftPaths: Set<string>
  heldInputs: Set<Set<string>>
  leases: Set<Set<string>>
  draft?: NativeChatComposerDraft
  referenceText?: string
  textReferences: Set<string>
  movedTo?: StagedFiles
  uploads: Map<string, Map<string, Promise<string>>>
}
const staged = new Map<string, StagedFiles>()
export const pendingResources = new WeakMap<
  object,
  Map<string, { resource: object; files: StagedFiles }>
>()

export function captureNativeChatStagedRemoval(scope: string, chips: readonly object[] = []) {
  const files = staged.get(scope)
  return {
    files,
    resources: new Map(files?.resources),
    heldInputs: new Set(files?.heldInputs),
    chips,
    deferPrune: false
  }
}
export type NativeChatStagedRemoval = ReturnType<typeof captureNativeChatStagedRemoval>

export function currentFiles(files: StagedFiles): StagedFiles {
  let owner = files
  while (owner.movedTo) {
    owner = owner.movedTo
  }
  while (files.movedTo && files.movedTo !== owner) {
    const next = files.movedTo
    files.movedTo = owner
    files = next
  }
  return owner
}

function inputPaths(files: StagedFiles, input: NativeChatStagedInput): string[] {
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

export function stageNativeChatDraftFile(scope: string, path: string, source?: object): void {
  let files = staged.get(scope)
  if (!files) {
    files = {
      scope,
      paths: new Set(),
      resources: new Map(),
      pending: new Map(),
      draftPaths: new Set(),
      heldInputs: new Set(),
      leases: new Set(),
      textReferences: new Set(),
      uploads: new Map()
    }
    staged.set(scope, files)
  }
  files.paths.add(path)
  const resource = {}
  files.resources.set(path, resource)
  if (source) {
    const resources = pendingResources.get(source) ?? new Map()
    resources.set(path, { resource, files })
    pendingResources.set(source, resources)
  }
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
    existing.resources.forEach((resource, path) => files.resources.set(path, resource))
    existing.pending.forEach((path, chip) => files.pending.set(chip, path))
    existing.draftPaths.forEach((path) => files.draftPaths.add(path))
    existing.leases.forEach((lease) => files.leases.add(lease))
    existing.heldInputs.forEach((held) => files.heldInputs.add(held))
    for (const [target, uploads] of existing.uploads) {
      const held = files.uploads.get(target) ?? new Map<string, Promise<string>>()
      uploads.forEach((upload, path) => held.set(path, held.get(path) ?? upload))
      files.uploads.set(target, held)
    }
    existing.movedTo = files
  }
  staged.set(to, files)
  files.scope = to
  staged.delete(from)
  files.draft = undefined
}

export function pruneFiles(files: StagedFiles, selected?: ReadonlyMap<string, object>): void {
  const liveChips = new Set<object>(nativeChatPendingAttachmentSnapshot(files.scope))
  const pendingPaths: string[] = []
  for (const [chip, path] of files.pending) {
    if (liveChips.has(chip)) {
      pendingPaths.push(path)
    } else {
      files.pending.delete(chip)
    }
  }
  const retained = new Set([
    ...files.draftPaths,
    ...pendingPaths,
    ...[...files.heldInputs].flatMap((held) => [...held]),
    ...[...files.leases].flatMap((lease) => [...lease])
  ])
  releaseFiles(
    files,
    [...files.paths].filter(
      (path) =>
        !retained.has(path) && (!selected || selected.get(path) === files.resources.get(path))
    )
  )
}

/** Draft edits release removed files; accepted sends keep their own leases until settlement. */
export function reconcileNativeChatStagedDraft(
  scope: string,
  draft?: NativeChatComposerDraft,
  removal?: NativeChatStagedRemoval
): void {
  const files = staged.get(scope)
  if (!files || (!removal && files.draft === draft)) {
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
  if (!removal?.deferPrune) {
    pruneFiles(files, removal?.resources)
  }
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
    files.resources.delete(path)
    files.draftPaths.delete(path)
    files.textReferences.delete(path)
    files.uploads.forEach((uploads) => uploads.delete(path))
  }
  if (!files.paths.size) {
    if (staged.get(files.scope) === files) {
      staged.delete(files.scope)
    }
  }
}

export function releaseNativeChatStagedFiles(scope: string): void {
  const files = staged.get(scope)
  if (files) {
    releaseFiles(files, [...files.paths])
  }
}

/** Keep the submitted files across draft moves, and retain successful uploads after a partial failure. */
export function captureNativeChatStagedInput(scope: string, input?: NativeChatStagedInput) {
  const files = staged.get(scope)
  const paths = files ? (input ? inputPaths(files, input) : [...files.paths]) : []
  const lease =
    [...(files?.heldInputs ?? [])].find(
      (held) => paths.length === held.size && paths.every((path) => held.has(path))
    ) ?? new Set(paths)
  files?.leases.add(lease)
  return {
    release: (input?: NativeChatStagedInput): void => {
      if (files) {
        const owner = currentFiles(files)
        const released = input ? inputPaths(owner, input) : [...lease]
        released.forEach((path) => lease.delete(path))
        if (!lease.size) {
          owner.leases.delete(lease)
          owner.heldInputs.delete(lease)
        }
        pruneFiles(owner)
      }
    },
    prepare: async <T extends NativeChatStagedInput>(
      input: T,
      session: { sessionId: string; runtimeEnvironmentId: string | null }
    ): Promise<T> => {
      if (!files || !session.runtimeEnvironmentId) {
        return input
      }
      const paths = inputPaths(currentFiles(files), input)
      if (!paths.length) {
        return input
      }
      return prepareNativeChatStagedUpload(input, session, paths, () => currentFiles(files))
    }
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
  const destination = nativeChatPendingAttachmentScope(scope, id)
  const chip = nativeChatPendingAttachmentSnapshot(destination).find((chip) => chip.id === id)
  stageNativeChatDraftFile(destination, path)
  const files = staged.get(destination)!
  if (chip) {
    files.pending.set(chip, path)
    const resources =
      pendingResources.get(chip) ?? new Map<string, { resource: object; files: StagedFiles }>()
    resources.set(path, { resource: files.resources.get(path)!, files })
    pendingResources.set(chip, resources)
  }
  return true
}

import type { NativeChatComposerImageAttachment } from './native-chat-composer-types'
import type { NativeChatPastedTextOperation } from './native-chat-pasted-text-reference'
import {
  staged,
  currentFiles,
  pendingResources,
  releaseFiles,
  type StagedFiles
} from './native-chat-staged-file-owner'
export { currentFiles, pendingResources, type StagedFiles } from './native-chat-staged-file-owner'
import {
  transferNativeChatStagedFiles,
  reconcileIncomingNativeChatStagedFiles,
  type NativeChatStagedTransfer
} from './native-chat-staged-file-transfer'
export type { NativeChatStagedTransfer } from './native-chat-staged-file-transfer'
import {
  nativeChatPendingAttachmentScope,
  nativeChatPendingAttachmentSource,
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

export function captureNativeChatStagedRemoval(
  scope: string,
  chips: readonly NativeChatComposerImageAttachment[] = []
) {
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

export function stageNativeChatDraftFile(
  scope: string,
  path: string,
  source?: NativeChatComposerImageAttachment | NativeChatPastedTextOperation
): void {
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
      draftReferences: new Set(),
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

export function moveNativeChatStagedFiles(
  from: string,
  to: string
): NativeChatStagedTransfer | undefined {
  if (from === to) {
    return
  }
  const source = staged.get(from)
  if (!source) {
    return
  }
  const files = currentFiles(source)
  const existing = staged.get(to)
  const destination = existing ? currentFiles(existing) : undefined
  if (files === destination) {
    staged.delete(from)
    return
  }
  const { owner, incoming } = transferNativeChatStagedFiles(files, destination)
  staged.set(to, owner)
  owner.scope = to
  staged.delete(from)
  return incoming
}

export function pruneFiles(files: StagedFiles, selected?: ReadonlyMap<string, object>): void {
  const liveChips = new Set<NativeChatComposerImageAttachment>(
    nativeChatPendingAttachmentSnapshot(files.scope)
  )
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
  removal?: NativeChatStagedRemoval,
  incoming?: NativeChatStagedTransfer
): void {
  const files = staged.get(scope)
  if (!files) {
    return
  }
  const previous = files.draft
  files.draft = draft
  const unchanged =
    previous === draft ||
    (previous &&
      draft &&
      previous.text === draft.text &&
      previous.images === draft.images &&
      previous.pastedTextFiles === draft.pastedTextFiles)
  if (!removal && unchanged) {
    if (incoming) {
      reconcileIncomingNativeChatStagedFiles(files, incoming)
    }
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
  if (!unchanged) {
    files.draftReferences = new Set([
      ...files.textReferences,
      ...(draft?.images.map(({ path }) => path) ?? []),
      ...Object.values(draft?.pastedTextFiles ?? {})
    ])
  }
  files.draftPaths = new Set([...files.paths].filter((path) => files.draftReferences.has(path)))
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
  const chip = id ? nativeChatPendingAttachmentSource(scope, id) : undefined
  if (!id || !chip) {
    releaseBrowserAttachmentFiles([path])
    return false
  }
  const destination = nativeChatPendingAttachmentScope(scope, id)
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

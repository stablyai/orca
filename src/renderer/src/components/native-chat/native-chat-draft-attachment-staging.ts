import {
  hasNativeChatPendingAttachment,
  nativeChatPendingAttachmentScope
} from './native-chat-pending-attachment-cache'
import { formatNativeChatFileReference } from '../../../../shared/agent-image-paste'
import { nativeChatTextAttachmentParts } from '../../../../shared/native-chat-text-attachment-references'
import type { NativeChatComposerDraft } from './native-chat-composer-draft-storage'
import { releaseBrowserAttachmentFiles } from '@/lib/browser-attachment-files'

export type NativeChatStagedInput = {
  text: string
  attachments?: readonly { path: string }[]
}

type StagedFiles = {
  paths: Set<string>
  draftPaths: Set<string>
  heldInputs: Set<Set<string>>
  leases: Set<Set<string>>
  /** The draft last reconciled; `unreconciled` until one is, so even an absent draft prunes. */
  draft?: NativeChatComposerDraft | typeof UNRECONCILED
  referenceText?: string
  textReferences: Set<string>
  movedTo?: StagedFiles
  uploads: Map<string, Map<string, Promise<string>>>
}
const staged = new Map<string, StagedFiles>()
const UNRECONCILED = Symbol('unreconciled')

function currentFiles(files: StagedFiles): StagedFiles {
  return files.movedTo ? currentFiles(files.movedTo) : files
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

/** The input's files this window still holds as client paths: what its host must receive first. */
export function nativeChatStagedInputPaths(scope: string, input: NativeChatStagedInput): string[] {
  const files = staged.get(scope)
  return files ? inputPaths(currentFiles(files), input) : []
}

function scopeFiles(scope: string): StagedFiles {
  let files = staged.get(scope)
  if (!files) {
    files = {
      paths: new Set(),
      draftPaths: new Set(),
      heldInputs: new Set(),
      leases: new Set(),
      draft: UNRECONCILED,
      textReferences: new Set(),
      uploads: new Map()
    }
    staged.set(scope, files)
  }
  return files
}

export function stageNativeChatDraftFile(scope: string, path: string): void {
  const files = scopeFiles(scope)
  files.paths.add(path)
  files.draftPaths.add(path)
}

/** Holds a saved message's files again after a reload, only by the paths its record listed, under
 *  a lease its capture releases; nothing is guessed from the message's text. */
export function restoreNativeChatStagedInput(
  scope: string,
  paths: readonly string[],
  input: NativeChatStagedInput
): ReturnType<typeof captureNativeChatStagedInput> {
  const files = scopeFiles(scope)
  paths.forEach((path) => files.paths.add(path))
  return captureNativeChatStagedInput(scope, input)
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
    existing.heldInputs.forEach((held) => files.heldInputs.add(held))
    for (const [target, uploads] of existing.uploads) {
      const held = files.uploads.get(target) ?? new Map<string, Promise<string>>()
      uploads.forEach((upload, path) => held.set(path, held.get(path) ?? upload))
      files.uploads.set(target, held)
    }
    existing.movedTo = files
  }
  staged.set(to, files)
  staged.delete(from)
  files.draft = UNRECONCILED
}

function pruneFiles(files: StagedFiles): void {
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
    typeof previous === 'object' &&
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

/** Keep the submitted files across draft moves, and retain successful uploads after a partial failure. */
export function captureNativeChatStagedInput(scope: string, input?: NativeChatStagedInput) {
  const files = staged.get(scope)
  const paths = files ? (input ? inputPaths(files, input) : [...files.paths]) : []
  const lease =
    [...(files?.heldInputs ?? [])].find(
      (held) => paths.length === held.size && paths.every((path) => held.has(path))
    ) ?? new Set(paths)
  files?.leases.add(lease)
  const release = (input?: NativeChatStagedInput): void => {
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
  }
  return {
    release,
    /** Files kept in another scope's draft are that draft's from now: this lease no longer frees
     *  them. In the lease's own scope its draft and the lease both hold them. */
    transfer: (scope: string): void => {
      const owner = files && currentFiles(files)
      if (owner && scopeFiles(scope) !== owner) {
        lease.forEach((path) => owner.paths.delete(path) && stageNativeChatDraftFile(scope, path))
      }
    },
    /** `launchOperationId`: the prepared launch that founds a chat not yet on its host. */
    prepare: async <T extends NativeChatStagedInput>(
      input: T,
      session: {
        sessionId: string
        runtimeEnvironmentId: string | null
        launchOperationId?: string
      }
    ): Promise<T> => {
      if (!files || !session.runtimeEnvironmentId) {
        return input
      }
      const paths = inputPaths(currentFiles(files), input)
      if (!paths.length) {
        return input
      }
      const {
        prepareNativeChatSessionAttachmentUpload,
        resolveNativeChatRuntimeSessionAttachmentOwner,
        uploadNativeChatSessionAttachmentPaths
      } = await import('./native-chat-attachment-upload')
      const owner = resolveNativeChatRuntimeSessionAttachmentOwner({
        sessionId: session.sessionId,
        runtimeEnvironmentId: session.runtimeEnvironmentId
      })
      if (owner.kind !== 'runtime-session') {
        throw new Error('The chat attachment host is unavailable.')
      }
      const prepared = await prepareNativeChatSessionAttachmentUpload(owner)
      if (!prepared.ok) {
        throw new Error(prepared.notice)
      }
      const target = session.launchOperationId
        ? { ...prepared.target, launchOperationId: session.launchOperationId }
        : prepared.target
      const ownerFiles = currentFiles(files)
      // The whole receiving identity, launch included: an upload is never reused for another.
      const key = JSON.stringify(target)
      const uploads = ownerFiles.uploads.get(key) ?? new Map<string, Promise<string>>()
      ownerFiles.uploads.set(key, uploads)
      const missing = paths.filter((path) => !uploads.has(path))
      if (missing.length) {
        const upload = uploadNativeChatSessionAttachmentPaths(missing, target)
        for (const source of missing) {
          const saved = upload.then((result) => {
            const uploaded = result.uploaded.find((file) => file.sourcePath === source)
            if (uploaded) {
              return uploaded.path
            }
            throw new Error(
              result.failed.find((file) => file.sourcePath === source)?.reason ||
                'Some attachments could not be uploaded.'
            )
          })
          uploads.set(source, saved)
          void saved.catch(() => {
            const currentUploads = currentFiles(files).uploads.get(key)
            if (currentUploads?.get(source) === saved) {
              currentUploads.delete(source)
            }
          })
        }
      }
      const uploaded = new Map(
        await Promise.all(paths.map(async (path) => [path, await uploads.get(path)!] as const))
      )
      const text = nativeChatTextAttachmentParts(input.text, true, (path) => uploaded.has(path))
        .map((part) =>
          part.path ? formatNativeChatFileReference(uploaded.get(part.path)!) : part.text
        )
        .join('')
      return {
        ...input,
        text,
        attachments: input.attachments?.map((image) => ({
          ...image,
          path: uploaded.get(image.path) ?? image.path
        }))
      }
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
  stageNativeChatDraftFile(nativeChatPendingAttachmentScope(scope, id), path)
  return true
}

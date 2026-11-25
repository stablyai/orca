import { formatNativeChatFileReference } from '../../../../../shared/native-chat/input/composer/agent-image-paste'
import { nativeChatTextAttachmentParts } from '../../../../../shared/native-chat/attachments/native-chat-text-attachment-references'
import {
  adoptNativeChatStagedFile,
  currentFiles,
  inputPaths,
  nativeChatStagedFileHeld,
  nativeChatStagedFileOwners,
  pruneFiles,
  stagedNativeChatFiles,
  type NativeChatStagedInput
} from './native-chat-draft-attachment-staging'

/** Keep the submitted files across draft moves, and retain successful uploads after a partial failure. */
export function captureNativeChatStagedInput(scope: string, input?: NativeChatStagedInput) {
  const files = stagedNativeChatFiles(scope)
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
        owner.pendingLeases.delete(lease)
      }
      pruneFiles(owner)
    }
  }
  return {
    release,
    /**
     * Release once the draft holds every submitted file: now, or at the first draft change that makes
     * it so (a returned original, or a live host upload of it). Until then the originals stay readable.
     */
    releaseWhenHeld: (): void => {
      const owner = files && currentFiles(files)
      if (!owner || [...lease].every((path) => nativeChatStagedFileHeld(owner, path))) {
        release()
      } else {
        owner.pendingLeases.add(lease)
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
      const { prepareNativeChatSessionAttachmentUpload, uploadNativeChatSessionAttachmentPaths } =
        await import('../attachments/uploads/native-chat-session-attachment-upload')
      const { resolveNativeChatRuntimeSessionAttachmentOwner } =
        await import('../attachments/uploads/native-chat-attachment-owner')
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
      const ownerFiles = currentFiles(files)
      const key = JSON.stringify(prepared.target)
      const uploads = ownerFiles.uploads.get(key) ?? new Map<string, Promise<string>>()
      ownerFiles.uploads.set(key, uploads)
      const missing = paths.filter((path) => !uploads.has(path))
      if (missing.length) {
        const upload = uploadNativeChatSessionAttachmentPaths(missing, prepared.target)
        for (const source of missing) {
          const saved = upload.then((result) => {
            const uploaded = result.uploaded.find((file) => file.sourcePath === source)
            if (uploaded) {
              currentFiles(files).uploaded.set(uploaded.path, {
                target: key,
                source,
                sessionId: prepared.target.sessionId,
                upload: saved
              })
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

/**
 * A host refused uploads it no longer stores, for a message of conversation `sessionId` returning to
 * `scope`. The authority is the upload's own identity: an expired host path is restored only when
 * exactly one live upload record names it, that record was made for this same conversation, and its
 * original is still staged. Then only that cached upload is forgotten (a healthy or newer upload of the
 * same original stays), the original moves into `scope`'s own staging so this draft owns it from now on,
 * and the original is returned so the returned message offers it again. Anything else is left out.
 * Restoring happens only here, while Orca builds the returned message: nothing rewrites a draft later.
 */
export function restoreNativeChatExpiredUploads(
  scope: string,
  sessionId: string,
  expiredHostPaths: Iterable<string>
): Map<string, string> {
  const restored = new Map<string, string>()
  for (const host of new Set(expiredHostPaths)) {
    const owners = nativeChatStagedFileOwners().filter((owner) => owner.uploaded.has(host))
    const owner = owners.length === 1 ? owners[0] : undefined
    const origin = owner?.uploaded.get(host)
    if (!owner || !origin || origin.sessionId !== sessionId || !owner.paths.has(origin.source)) {
      continue
    }
    owner.uploaded.delete(host)
    const cache = owner.uploads.get(origin.target)
    if (cache?.get(origin.source) === origin.upload) {
      cache.delete(origin.source)
    }
    adoptNativeChatStagedFile(owner, origin.source, scope)
    restored.set(host, origin.source)
  }
  return restored
}

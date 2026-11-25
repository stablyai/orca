import { formatNativeChatFileReference } from '../../../../../shared/native-chat/input/composer/agent-image-paste'
import { nativeChatTextAttachmentParts } from '../../../../../shared/native-chat/attachments/native-chat-text-attachment-references'
import {
  currentFiles,
  inputPaths,
  nativeChatStagedFileHeld,
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
              currentFiles(files).uploaded.set(uploaded.path, { target: key, source })
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
 * A host refused uploads it no longer stores. For each expired host path whose staged original this
 * draft still holds, forget that one cached upload (healthy uploads stay) and return the original, so the
 * returned message can offer it again and the next send uploads it afresh. Unknown paths are left out.
 */
export function restoreNativeChatExpiredUploads(
  scope: string,
  expiredHostPaths: Iterable<string>
): Map<string, string> {
  const files = stagedNativeChatFiles(scope)
  const restored = new Map<string, string>()
  if (!files) {
    return restored
  }
  const owner = currentFiles(files)
  for (const host of expiredHostPaths) {
    const origin = owner.uploaded.get(host)
    if (origin && owner.paths.has(origin.source)) {
      owner.uploaded.delete(host)
      owner.uploads.get(origin.target)?.delete(origin.source)
      restored.set(host, origin.source)
    }
  }
  return restored
}

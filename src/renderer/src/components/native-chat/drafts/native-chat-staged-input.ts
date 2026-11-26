import { formatNativeChatFileReference } from '../../../../../shared/native-chat/input/composer/agent-image-paste'
import { nativeChatTextAttachmentParts } from '../../../../../shared/native-chat/attachments/native-chat-text-attachment-references'
import {
  currentFiles,
  inputPaths,
  nativeChatStagedFileHeld,
  nativeChatStagedFileOwners,
  pruneFiles,
  stagedNativeChatFiles,
  type NativeChatStagedInput,
  type StagedFiles
} from './native-chat-draft-attachment-staging'
import { withoutUnownedBrowserFiles } from './native-chat-expired-upload-restore'

type UploadSession = { sessionId: string; runtimeEnvironmentId: string | null }

/** The staging that holds this cached upload now: adoption can move it to another draft mid-flight. */
function uploadHolder(
  target: string,
  source: string,
  upload: Promise<string>
): StagedFiles | undefined {
  return nativeChatStagedFileOwners().find(
    (owner) => owner.uploads.get(target)?.get(source) === upload
  )
}

/** Upload the staged originals `input` names, and map them to their host paths. */
async function uploadStagedInput<T extends NativeChatStagedInput>(
  files: StagedFiles | undefined,
  input: T,
  session: UploadSession
): Promise<T> {
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
      // Settles with whichever staging holds it by then, not the one that started it.
      const saved: Promise<string> = upload.then((result) => {
        const uploaded = result.uploaded.find((file) => file.sourcePath === source)
        if (uploaded) {
          ;(uploadHolder(key, source, saved) ?? currentFiles(files)).uploaded.set(uploaded.path, {
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
        uploadHolder(key, source, saved)?.uploads.get(key)?.delete(source)
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
    /**
     * The payload as it leaves: staged originals become host uploads, then, fail-closed and checked at
     * this moment (after every upload settled, whatever the plan held when it was made), no browser-file
     * reference the sending staging does not own goes out, attachment or text reference.
     */
    prepare: async <T extends NativeChatStagedInput>(
      input: T,
      session: UploadSession
    ): Promise<T> => {
      const prepared = await uploadStagedInput(files, input, session)
      return withoutUnownedBrowserFiles(files && currentFiles(files), prepared)
    }
  }
}

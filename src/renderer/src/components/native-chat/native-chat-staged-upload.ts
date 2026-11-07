import { formatNativeChatFileReference } from '../../../../shared/agent-image-paste'
import { nativeChatTextAttachmentParts } from '../../../../shared/native-chat-text-attachment-references'
import type { NativeChatStagedInput } from './native-chat-draft-attachment-staging'

export async function prepareNativeChatStagedUpload<T extends NativeChatStagedInput>(
  input: T,
  session: { sessionId: string; runtimeEnvironmentId: string | null },
  paths: readonly string[],
  getFiles: () => { uploads: Map<string, Map<string, Promise<string>>> }
): Promise<T> {
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
  const ownerFiles = getFiles()
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
          return uploaded.path
        }
        throw new Error(
          result.failed.find((file) => file.sourcePath === source)?.reason ||
            'Some attachments could not be uploaded.'
        )
      })
      uploads.set(source, saved)
      void saved.catch(() => {
        const currentUploads = getFiles().uploads.get(key)
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

import type { NativeChatComposerImageAttachment } from './native-chat-composer-types'
import type { NativeChatDraftReturnSource } from './native-chat-draft-return-products'
import type { NativeChatComposerDraft } from './native-chat-composer-draft-storage'
import { releaseBrowserAttachmentFiles } from '@/lib/browser-attachment-files'

export type StagedFiles = {
  scope: string
  paths: Set<string>
  resources: Map<string, object>
  pending: Map<NativeChatComposerImageAttachment, string>
  draftPaths: Set<string>
  heldInputs: Set<Set<string>>
  leases: Set<Set<string>>
  draft?: NativeChatComposerDraft
  referenceText?: string
  textReferences: Set<string>
  draftReferences: Set<string>
  movedTo?: StagedFiles
  uploads: Map<string, Map<string, Promise<string>>>
}
export const staged = new Map<string, StagedFiles>()
export const pendingResources = new WeakMap<
  NativeChatDraftReturnSource,
  Map<string, { resource: object; files: StagedFiles }>
>()

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

export function releaseFiles(files: StagedFiles, paths: string[]): void {
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

import {
  readBrowserAttachmentFile,
  releaseBrowserAttachmentFiles
} from '@/lib/browser-attachment-files'
import { userNamedFileAccess } from '@/lib/local-file-access'
import {
  nativeChatAttachmentOwnerChangedNotice,
  nativeChatAttachmentUnreadableNotice
} from './native-chat-attachment-notices'
import type { NativeChatAttachmentOwner } from '../uploads/native-chat-attachment-owner'
import { stageNativeChatDraftFile } from '../../drafts/native-chat-draft-attachment-staging'
import { isImageDropPath } from '../../../../../../shared/image-path-paste'
import { nativeChatPendingAttachmentScope } from '../chips/native-chat-pending-attachment-cache'
import type {
  NativeChatAttachmentFocusOptions,
  NativeChatResolvedPathOptions
} from '../uploads/native-chat-resolved-path-ownership'
import type {
  NativeChatPendingAttachmentChips,
  NativeChatReservedAttachment
} from './native-chat-session-attachment-drop'

export async function attachNativeChatLocalAttachmentPaths(args: {
  reserved: NativeChatReservedAttachment[]
  owner: NativeChatAttachmentOwner
  chips: NativeChatPendingAttachmentChips
  options?: NativeChatAttachmentFocusOptions
  claimedPaths: Set<string>
  isAbandoned: () => boolean
  ownerStillCurrent: () => boolean
  attachResolvedPaths: (
    paths: string[],
    connectionId?: string | null,
    options?: NativeChatResolvedPathOptions
  ) => void
  setNotice: (notice: string | null) => void
}): Promise<void> {
  const {
    reserved,
    owner,
    chips,
    options,
    claimedPaths,
    isAbandoned,
    ownerStillCurrent,
    attachResolvedPaths,
    setNotice
  } = args
  const pending = [...reserved]
  try {
    if (pending.length === 0) {
      return
    }
    const readable: typeof pending = []
    for (const entry of pending) {
      if (isAbandoned()) {
        return
      }
      if (!ownerStillCurrent()) {
        setNotice(nativeChatAttachmentOwnerChangedNotice())
        return
      }
      try {
        if (!readBrowserAttachmentFile(entry.path)) {
          await window.api.fs.stat({ filePath: entry.path, access: userNamedFileAccess() })
        }
        readable.push(entry)
      } catch {
        // Skip unreadable paths, matching workspace composer drops.
        chips.drop(entry.chipId)
      }
    }
    if (isAbandoned()) {
      return
    }
    if (!ownerStillCurrent()) {
      setNotice(nativeChatAttachmentOwnerChangedNotice())
      return
    }
    if (readable.length === 0) {
      setNotice(nativeChatAttachmentUnreadableNotice())
      return
    }
    const prepared = pending.splice(0)
    const retainedPaths = new Set<string>()
    readable.forEach(({ path }) => claimedPaths.add(path))
    attachResolvedPaths(
      readable.map(({ path }) => path),
      undefined,
      {
        ...options,
        destinationIsCurrent: ownerStillCurrent,
        operation: {
          apply: (insertReferences) => {
            const completion = { focus: false, insertReferences }
            let attached = false
            for (const { path, chipId } of readable) {
              const scope =
                owner.kind === 'local' && owner.stagingScope
                  ? nativeChatPendingAttachmentScope(owner.stagingScope, chipId)
                  : null
              const retained = isImageDropPath(path)
                ? chips.resolve(chipId, path, undefined, completion)
                : chips.attachReferences([{ id: chipId, path }], completion)
              if (retained && scope) {
                retainedPaths.add(path)
                stageNativeChatDraftFile(scope, path)
              }
              attached = retained || attached
            }
            return attached
          },
          cancel: () => {
            prepared.forEach(({ chipId }) => chips.drop(chipId))
            releaseBrowserAttachmentFiles(
              readable.filter(({ path }) => !retainedPaths.has(path)).map(({ path }) => path)
            )
          }
        }
      }
    )
  } catch {
    setNotice(nativeChatAttachmentUnreadableNotice())
  } finally {
    for (const { chipId } of pending) {
      chips.drop(chipId)
    }
  }
}

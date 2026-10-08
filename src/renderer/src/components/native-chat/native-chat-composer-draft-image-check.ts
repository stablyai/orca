// Which restored draft images are known to be gone. A paste in Orca's paste folder asks main
// whether it is still kept, which holds only for a file really inside that folder; a file a paired
// server stored for the chat is that server's to check, which its claim at send does; any other
// image goes through the existing existence check (the workspace's read rules locally, the host
// over SSH).

import { useEffect, useSyncExternalStore } from 'react'
import { isAgentSessionAttachmentStorePath } from '../../../../shared/agent-session-attachments'
import type { NativeChatComposerDraftImage } from './native-chat-composer-draft-storage'
import {
  isKeptLocalPaste,
  readNativeChatComposerDraft,
  isNativeChatComposerDraftUnverified,
  markNativeChatComposerDraftVerified,
  unavailableNativeChatComposerDraftImage,
  updateNativeChatComposerDraft
} from './native-chat-composer-draft-store'

/** Ids of images whose file is gone. One that cannot be checked (no read permission for that
 *  path, host not connected) counts as present: the send's own check still guards it. */
export async function findMissingNativeChatComposerDraftImages(
  images: readonly NativeChatComposerDraftImage[]
): Promise<Set<string>> {
  const api = typeof window === 'undefined' ? undefined : window.api
  const missing = new Set<string>()
  const checkable = images.filter((image) => image.unavailableName === undefined && image.path)
  const pastes = checkable.filter(isKeptLocalPaste)
  if (pastes.length > 0 && api?.ui?.restoreNativeChatPastes) {
    try {
      const restored = await api.ui.restoreNativeChatPastes(pastes.map(({ path }) => path))
      const kept = new Set(restored.filter((r) => r.kept && r.exists).map(({ path }) => path))
      pastes.filter(({ path }) => !kept.has(path)).forEach(({ id }) => missing.add(id))
    } catch {
      // Unknown, not gone.
    }
  }
  const pathExists = api?.fs?.pathExists
  if (!pathExists) {
    return missing
  }
  await Promise.all(
    checkable
      .filter((image) => !isKeptLocalPaste(image) && !isAgentSessionAttachmentStorePath(image.path))
      .map(async (image) => {
        try {
          const exists = await pathExists({
            filePath: image.path,
            ...(image.connectionId ? { connectionId: image.connectionId } : {})
          })
          if (!exists) {
            missing.add(image.id)
          }
        } catch {
          // Unknown, not gone.
        }
      })
  )
  return missing
}

const checking = new Set<string>()

/** Once per restored draft: an image whose file is gone comes back as one to attach again. */
export async function verifyRestoredNativeChatComposerDraftImages(scopeKey: string): Promise<void> {
  if (!isNativeChatComposerDraftUnverified(scopeKey) || checking.has(scopeKey)) {
    return
  }
  checking.add(scopeKey)
  try {
    await replaceMissingImages(scopeKey)
  } finally {
    checking.delete(scopeKey)
    markNativeChatComposerDraftVerified(scopeKey)
  }
}

async function replaceMissingImages(scopeKey: string): Promise<void> {
  const checked = readNativeChatComposerDraft(scopeKey).images
  const missing = await findMissingNativeChatComposerDraftImages(checked)
  if (missing.size === 0) {
    return
  }
  const gone = new Set(checked.filter((image) => missing.has(image.id)).map(({ path }) => path))
  updateNativeChatComposerDraft(
    scopeKey,
    {
      images: readNativeChatComposerDraft(scopeKey).images.map((image) =>
        missing.has(image.id) && gone.has(image.path)
          ? unavailableNativeChatComposerDraftImage(image)
          : image
      )
    },
    'immediate'
  )
}

/** Whether the scope's restored images still wait on their check, which runs as they arrive: at
 *  mount, or later when the startup load or another window brings new ones. */
export function useRestoredNativeChatComposerDraftImageCheck(
  scopeKey: string,
  subscribe: (listener: () => void) => () => void
): boolean {
  const restoring = useSyncExternalStore(subscribe, () =>
    isNativeChatComposerDraftUnverified(scopeKey)
  )
  useEffect(() => {
    if (restoring) {
      void verifyRestoredNativeChatComposerDraftImages(scopeKey)
    }
  }, [scopeKey, restoring])
  return restoring
}

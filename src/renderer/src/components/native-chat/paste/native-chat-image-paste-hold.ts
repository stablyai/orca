import {
  holdNativeChatPendingImageSave,
  releaseNativeChatPendingImageSave
} from '../attachments/chips/native-chat-pending-attachment-scopes'

/**
 * Hold the chip while main saves it, so a composer going unavailable cannot discard it. `settle` runs
 * in the save's own continuation, followed at once by the release and `afterSave` (drain and notice),
 * so a draft move cannot land between the chip leaving its draft and the notice being routed.
 */
export async function holdingPendingImageSave<T>(
  pendingId: string | null,
  save: () => Promise<T>,
  settle: (saved: T) => boolean,
  afterSave: () => void
): Promise<boolean> {
  if (pendingId) {
    holdNativeChatPendingImageSave(pendingId)
  }
  try {
    return settle(await save())
  } finally {
    if (pendingId) {
      releaseNativeChatPendingImageSave(pendingId)
    }
    afterSave()
  }
}

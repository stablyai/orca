import type { GlobalSettings } from '../../../shared/global-settings-types'
import { isNativeChatEnabled } from '../../../shared/structured-native-chat-launch-route'

/**
 * Whether this machine can have structured chats worth mirroring: Chat UI is on, or the local host
 * holds a session record. Asked fresh each time rather than remembered. With Chat UI off nothing
 * can create a session, so a "no" stays true until Chat UI comes on, and a user who never had a
 * structured chat pays only the host's cheap existence check.
 */
export async function localStructuredSessionsMayExist(
  settings: Pick<GlobalSettings, 'experimentalNativeChat'> | null | undefined
): Promise<boolean> {
  if (isNativeChatEnabled(settings)) {
    return true
  }
  try {
    return await window.api.app.hasLocalStructuredAgentSessions()
  } catch {
    // An unanswered check must not hide chats that may be open.
    return true
  }
}

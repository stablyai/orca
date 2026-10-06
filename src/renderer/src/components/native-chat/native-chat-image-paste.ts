import { isImageDropPath } from '../terminal-pane/terminal-drop-image-path'
import { NATIVE_CHAT_PASTE_FOLDER } from '../../../../shared/native-chat-paste-folder'
export {
  getAgentImageHandling,
  type AgentImageHandling
} from '../../../../shared/agent-image-paste'

export function isNativeChatImageAttachmentPath(path: string): boolean {
  return isImageDropPath(path)
}

/** True when a path is a clipboard-paste temp file (`orca-paste-<ts>-<uuid>.png`).
 *  Those names are noise in the UI, so the composer shows a friendly label
 *  instead of the basename. */
export function isNativeChatPastedImagePath(path: string): boolean {
  const base = path.split(/[\\/]/).findLast(Boolean) ?? path
  return /^orca-paste-.+\.png$/i.test(base)
}

/** True for a local paste Orca keeps in its paste folder, judged from the path alone; main checks
 *  the real file before a restore keeps it. */
export function isNativeChatKeptPastePath(path: string): boolean {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts.at(-2) === NATIVE_CHAT_PASTE_FOLDER && isNativeChatPastedImagePath(path)
}

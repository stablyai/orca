import { isImageDropPath } from '../terminal-pane/terminal-drop-image-path'
import { NATIVE_CHAT_PASTE_FOLDER } from '../../../../shared/native-chat/input/native-chat-paste-folder'
export {
  getAgentImageHandling,
  type AgentImageHandling
} from '../../../../shared/agent-image-paste'

export function isNativeChatImageAttachmentPath(path: string): boolean {
  return isImageDropPath(path)
}

/** Use friendly UI labels for Orca clipboard-image temp filenames. */
export function isNativeChatPastedImagePath(path: string): boolean {
  const base = path.split(/[\\/]/).findLast(Boolean) ?? path
  return /^orca-paste-.+\.png$/i.test(base)
}

/** True for a long text paste Orca saved as a file (`orca-paste-<ts>-<uuid>.txt`). */
export function isNativeChatPastedTextPath(path: string): boolean {
  const base = path.split(/[\\/]/).findLast(Boolean) ?? path
  return /^orca-paste-.+\.txt$/i.test(base)
}

/** Recognize legacy paste-folder paths; main still validates the actual file before restore. */
export function isNativeChatKeptPastePath(path: string): boolean {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts.at(-2) === NATIVE_CHAT_PASTE_FOLDER && isNativeChatPastedImagePath(path)
}

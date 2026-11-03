import { isImageDropPath } from '../terminal-pane/terminal-drop-image-path'
import { NATIVE_CHAT_PASTE_FOLDER } from '../../../../shared/native-chat/input/native-chat-paste-folder'
import { isNativeChatPastedImagePath } from '../../../../shared/native-chat/native-chat-image-label'
export {
  getAgentImageHandling,
  type AgentImageHandling
} from '../../../../shared/agent-image-paste'

export function isNativeChatImageAttachmentPath(path: string): boolean {
  return isImageDropPath(path)
}

/** Recognize legacy paste-folder paths; main still validates the actual file before restore. */
export function isNativeChatKeptPastePath(path: string): boolean {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts.at(-2) === NATIVE_CHAT_PASTE_FOLDER && isNativeChatPastedImagePath(path)
}

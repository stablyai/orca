import { isImageDropPath } from '../terminal-pane/terminal-drop-image-path'
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

// Pure decision layer for image paste. The composer persists a pasted image to
// a temp file (via the preload clipboard API) and then needs to know, per
// agent, whether that file can be sent as a TUI image attachment. Confirmed
// agents get a native attachment chip; unsupported/custom agents get a clear
// message instead of silently injecting a path that the model reads as text.

import { isImageDropPath } from '../terminal-pane/terminal-drop-image-path'

export { getAgentImageHandling } from '../../../../shared/agent-image-handling'

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

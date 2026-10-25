// Share exact PTY composer bytes across desktop/mobile.

import {
  sanitizeBracketedPasteText,
  wrapTerminalBracketedPasteText
} from './terminal-bracketed-paste-text'

// PTY Enter is carriage return, not newline.
const SUBMIT = '\r'

/** Any CR/LF, including a trailing newline, needs bracketed-paste framing. */
export function isMultilineDraft(text: string): boolean {
  return /[\r\n]/.test(text)
}

/** Write Enter separately from the framed body; see buildNativeChatPasteBytes. */
export const NATIVE_CHAT_SUBMIT = SUBMIT

/** Build sanitized body bytes, bracket-framed for multiline input, without submit.
 * Agent TUIs treat CR in the same PTY write as pasted body, leaving text unsent. Write NATIVE_CHAT_SUBMIT separately after a short delay,
 * matching orca-runtime writeTerminalAction Enter handling. */
export function buildNativeChatPasteBytes(text: string): string {
  if (isMultilineDraft(text)) {
    return wrapTerminalBracketedPasteText(text)
  }
  // Sanitize unframed text too so pasted scrollback cannot inject terminal escapes.
  return sanitizeBracketedPasteText(text)
}

/** Image attachments must look like a real terminal image paste to Claude/Codex
 *  TUIs. A plain typed path (or @file mention) is treated as text/file-read. */
export function buildNativeChatImagePasteBytes(filePath: string): string {
  return wrapTerminalBracketedPasteText(filePath)
}

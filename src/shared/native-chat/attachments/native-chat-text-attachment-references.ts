import { hasBinaryFileExtension } from '../../file-preview/binary-file-extensions'
import { AGENT_SESSION_ATTACHMENTS_DIR_NAME } from '../../agent-session/agent-session-attachments'

export function isCommittedChatAttachmentCandidate(path: string): boolean {
  return !hasBinaryFileExtension(path) && isChatAttachmentStorePath(path)
}

/** An absolute path to a committed file in a chat attachment store, of any kind. */
export function isChatAttachmentStorePath(path: string): boolean {
  return (
    /^(?:\/|[a-z]:[\\/]|\\\\)/i.test(path) &&
    new RegExp(
      `(?:^|[\\\\/])${AGENT_SESSION_ATTACHMENTS_DIR_NAME}[\\\\/][0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}[\\\\/][^\\\\/]+$`,
      'i'
    ).test(path) &&
    path.split(/[\\/]/).at(-1) !== '.upload.part'
  )
}

const REFERENCE_TOKEN = /@"(?:\\"|[^"])*"|@'[^']*'|@[^\s]+/g

// A terminal chat writes the stored file's path as typed text, spaces escaped with a backslash.
const REFERENCE_OR_PLAIN_UPLOAD_PATH = new RegExp(
  `${REFERENCE_TOKEN.source}|/(?:\\\\.|[^\\s\\\\])*?${AGENT_SESSION_ATTACHMENTS_DIR_NAME}/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/(?:\\\\.|[^\\s\\\\/])+`,
  'gi'
)

function referencedPath(token: string): string {
  if (token[1] === '"') {
    return token.slice(2, -1).replace(/\\"/g, '"')
  }
  return token[1] === "'" ? token.slice(2, -1) : token.slice(1)
}

export type ChatAttachmentPart = { text: string; path?: string }
/** Discover exact source tokens independently of their presentation. */
export function nativeChatTextAttachmentParts(
  text: string,
  structured: boolean,
  acceptPath: (path: string) => boolean = isCommittedChatAttachmentCandidate,
  plainUploadPaths = false
): ChatAttachmentPart[] {
  if (!structured) {
    return [{ text }]
  }
  const parts: ChatAttachmentPart[] = []
  const pattern = plainUploadPaths ? REFERENCE_OR_PLAIN_UPLOAD_PATH : REFERENCE_TOKEN
  let end = 0
  for (const match of text.matchAll(pattern)) {
    const token = match[0]
    if (token.length > 8192) {
      continue
    }
    const path = token.startsWith('@') ? referencedPath(token) : token.replace(/\\(.)/g, '$1')
    if (!acceptPath(path)) {
      continue
    }
    if (match.index > end) {
      parts.push({ text: text.slice(end, match.index) })
    }
    parts.push({ text: token, path })
    end = match.index + token.length
  }
  if (end < text.length) {
    parts.push({ text: text.slice(end) })
  }
  return parts.length ? parts : [{ text }]
}

export function chatTextAttachmentName(path: string, pastedText = 'Pasted text'): string {
  const name = path.split(/[\\/]/).at(-1) ?? path
  return /^orca-paste-.*\.txt$/.test(name) ? pastedText : name
}

export function nativeChatTextAttachmentPaths(text: string): string[] {
  return [
    ...new Set(
      nativeChatTextAttachmentParts(text, true).flatMap((part) => (part.path ? [part.path] : []))
    )
  ]
}

/** Every uploaded file a message references, binary or text, in first-seen order. */
export function nativeChatUploadedFilePaths(text: string): string[] {
  return [
    ...new Set(
      nativeChatTextAttachmentParts(text, true, isChatAttachmentStorePath, true).flatMap((part) =>
        part.path ? [part.path] : []
      )
    )
  ]
}

/** The message text without its uploaded-file reference tokens, which the transcript draws as file chips. */
export function nativeChatTextWithoutUploadedFiles(text: string): string {
  return nativeChatTextAttachmentParts(text, true, isChatAttachmentStorePath, true)
    .filter((part) => part.path === undefined)
    .map((part) => part.text)
    .join('')
    .trim()
}

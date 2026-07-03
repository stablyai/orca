export const COMMENT_BODY_NONBLANK_SCAN_MAX_BYTES = 64 * 1024

export type CommentBodySubmitState =
  | { status: 'empty' }
  | { status: 'too-large-leading-whitespace' }
  | { status: 'ready'; body: string }

type CommentBodyPresence = 'empty' | 'present' | 'too-large-leading-whitespace'

function getCodePointUtf8ByteLength(codePoint: number): number {
  if (codePoint <= 0x7f) {
    return 1
  }
  if (codePoint <= 0x7ff) {
    return 2
  }
  if (codePoint <= 0xffff) {
    return 3
  }
  return 4
}

function getCommentBodyPresence(
  body: string,
  maxScanBytes = COMMENT_BODY_NONBLANK_SCAN_MAX_BYTES
): CommentBodyPresence {
  let scannedBytes = 0

  for (let index = 0; index < body.length; index += 1) {
    const codePoint = body.codePointAt(index) ?? 0
    const codeUnitLength = codePoint > 0xffff ? 2 : 1
    scannedBytes += getCodePointUtf8ByteLength(codePoint)
    if (scannedBytes > maxScanBytes) {
      return 'too-large-leading-whitespace'
    }

    if (/\S/u.test(body.slice(index, index + codeUnitLength))) {
      return 'present'
    }
    if (codeUnitLength === 2) {
      index += 1
    }
  }

  return 'empty'
}

export function hasBoundedCommentBodyText(body: string): boolean {
  return getCommentBodyPresence(body) === 'present'
}

export function getCommentBodySubmitState(body: string): CommentBodySubmitState {
  const presence = getCommentBodyPresence(body)
  if (presence === 'empty') {
    return { status: 'empty' }
  }
  if (presence === 'too-large-leading-whitespace') {
    return { status: 'too-large-leading-whitespace' }
  }

  return { status: 'ready', body: body.trim() }
}

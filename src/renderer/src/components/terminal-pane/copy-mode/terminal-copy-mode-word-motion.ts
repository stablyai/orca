import type { CopyModeBuffer, CopyModePosition } from './terminal-copy-mode-buffer'

type WordMotion =
  | 'wordForward'
  | 'wordBackward'
  | 'wordEnd'
  | 'previousWordEnd'
  | 'bigWordForward'
  | 'bigWordBackward'
  | 'bigWordEnd'
  | 'previousBigWordEnd'

export function moveCopyModeWord(
  buffer: CopyModeBuffer,
  position: CopyModePosition,
  motion: WordMotion
): CopyModePosition {
  const big =
    motion === 'bigWordForward' ||
    motion === 'bigWordBackward' ||
    motion === 'bigWordEnd' ||
    motion === 'previousBigWordEnd'
  const kind = (point: CopyModePosition): string => {
    if (buffer.isBlankLine(point)) {
      return 'blank'
    }
    const text = buffer.text(point)
    if (!text.trim()) {
      return 'space'
    }
    if (big) {
      return 'word'
    }
    if (/\p{Script=Han}/u.test(text)) {
      return 'han'
    }
    return /[\p{L}\p{N}\p{M}_]/u.test(text) ? 'word' : 'punctuation'
  }
  const sameRun = (a: CopyModePosition, b: CopyModePosition): boolean => {
    const type = kind(a)
    return type !== 'blank' && type !== 'han' && type === kind(b) && buffer.joins(a, b)
  }
  const skipSpace = (start: CopyModePosition, direction: 'next' | 'previous'): CopyModePosition => {
    let current = start
    while (kind(current) === 'space') {
      const next = buffer[direction](current)
      if (!next) {
        break
      }
      current = next
    }
    return current
  }
  if (motion === 'wordBackward' || motion === 'bigWordBackward') {
    let current = skipSpace(buffer.previous(position) ?? position, 'previous')
    let previous = buffer.previous(current)
    while (previous && sameRun(previous, current)) {
      current = previous
      previous = buffer.previous(current)
    }
    return current
  }
  if (motion === 'previousWordEnd' || motion === 'previousBigWordEnd') {
    let current = buffer.previous(position) ?? position
    if (sameRun(current, position)) {
      let previous = buffer.previous(current)
      while (previous && sameRun(previous, current)) {
        current = previous
        previous = buffer.previous(current)
      }
      current = previous ?? current
    }
    return skipSpace(current, 'previous')
  }
  if (motion === 'wordForward' || motion === 'bigWordForward') {
    let current = position
    let next = buffer.next(current)
    if (kind(current) !== 'space') {
      while (next && sameRun(current, next)) {
        current = next
        next = buffer.next(current)
      }
      current = next ?? current
    }
    return skipSpace(current, 'next')
  }
  let current = skipSpace(buffer.next(position) ?? position, 'next')
  let next = buffer.next(current)
  while (next && sameRun(current, next)) {
    current = next
    next = buffer.next(current)
  }
  return current
}

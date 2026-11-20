/**
 * A global regex's matches from its lastIndex on, as if it opened with a lookbehind: one `accept`
 * refuses is retried a character later. WebKit before Safari 16.4 (iOS 16.0-16.3) cannot parse a
 * lookbehind, so code the mobile page runs uses this. The caller owns `pattern` and may move its
 * lastIndex between matches; `pattern` must never match an empty string.
 */
export function* acceptedMatches(
  text: string,
  pattern: RegExp,
  accept: (match: RegExpExecArray) => boolean
): Generator<RegExpExecArray, void, undefined> {
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    if (accept(match)) {
      yield match
    } else {
      const astral = pattern.unicode && (text.codePointAt(match.index) ?? 0) > 0xffff
      pattern.lastIndex = match.index + (astral ? 2 : 1)
    }
  }
}

/**
 * A sticky regex's matches at the positions `startsHere` allows, as if the pattern opened with that
 * lookbehind. The position is checked before the pattern runs, so a refused position is never
 * scanned and a long run behind one stays linear. `stickyPattern` must never match an empty string.
 */
export function* stickyMatchesWhere(
  text: string,
  stickyPattern: RegExp,
  startsHere: (index: number) => boolean
): Generator<RegExpExecArray, void, undefined> {
  let index = 0
  while (index < text.length) {
    stickyPattern.lastIndex = index
    const match = startsHere(index) ? stickyPattern.exec(text) : null
    if (match) {
      yield match
      index = match.index + match[0].length
    } else {
      const astral = stickyPattern.unicode && (text.codePointAt(index) ?? 0) > 0xffff
      index += astral ? 2 : 1
    }
  }
}

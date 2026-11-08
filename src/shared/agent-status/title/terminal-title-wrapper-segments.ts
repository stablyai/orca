const WRAPPER_SEPARATOR = ' | '

/** Check whole-to-innermost titles so wrapper prefixes such as zsh | do not hide an anchored pane identity. */
export function getWrapperTitleSegments(title: string): string[] {
  const segments = [title]
  let separatorIndex = title.indexOf(WRAPPER_SEPARATOR)
  while (separatorIndex >= 0) {
    const wrapped = title.slice(separatorIndex + WRAPPER_SEPARATOR.length).trim()
    if (wrapped && !segments.includes(wrapped)) {
      segments.push(wrapped)
    }
    separatorIndex = title.indexOf(WRAPPER_SEPARATOR, separatorIndex + WRAPPER_SEPARATOR.length)
  }
  return segments
}

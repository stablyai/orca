// A composer image chip's text form. It names which attached image it means, never a number: the
// number is drawn from the thumbnail row on screen and worked out once at send.

const IMAGE_REFERENCES = /\[Image\]\(orca-image:([A-Za-z0-9._:-]{1,200})\)/g

export function imageReferenceToken(attachmentId: string): string {
  return `[Image](orca-image:${attachmentId})`
}

/** Spaces keep inserted chips separate from the words on either side of the caret. */
export function imageReferenceInsertion(
  before: string,
  after: string,
  ids: readonly string[]
): string {
  if (ids.length === 0) {
    return ''
  }
  const tokens = ids.map(imageReferenceToken).join(' ')
  return `${before && !/\s$/.test(before) ? ' ' : ''}${tokens}${/^\s/.test(after) ? '' : ' '}`
}

/** The text's runs and the images its tokens name, in order; empty runs are left out. */
export function splitImageReferences(text: string): (string | { attachmentId: string })[] {
  const parts: (string | { attachmentId: string })[] = []
  let last = 0
  for (const match of text.matchAll(IMAGE_REFERENCES)) {
    if (match.index > last) {
      parts.push(text.slice(last, match.index))
    }
    parts.push({ attachmentId: match[1] ?? '' })
    last = match.index + match[0].length
  }
  if (last < text.length) {
    parts.push(text.slice(last))
  }
  return parts
}

/** Replaces every token with what `replace` gives for the image it names. */
export function replaceImageReferences(
  text: string,
  replace: (attachmentId: string) => string
): string {
  return text.replace(IMAGE_REFERENCES, (_token, attachmentId: string) => replace(attachmentId))
}

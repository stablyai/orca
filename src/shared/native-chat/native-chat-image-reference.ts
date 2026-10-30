// Image chip tokens retain attachment identity; thumbnail order supplies numbers only at send.

const IMAGE_REFERENCES = /\[Image\]\(orca-image:([A-Za-z0-9._:-]{1,200})\)/g

export function imageReferenceToken(attachmentId: string): string {
  return `[Image](orca-image:${attachmentId})`
}

/** Each chip goes with the space inserted after it, as the editor deletes it. */
export function withoutImageReference(text: string, attachmentId: string): string {
  const token = imageReferenceToken(attachmentId)
  return text.replaceAll(`${token} `, '').replaceAll(token, '')
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

export function replaceImageReferences(
  text: string,
  replace: (attachmentId: string) => string
): string {
  return text.replace(IMAGE_REFERENCES, (_token, attachmentId: string) => replace(attachmentId))
}

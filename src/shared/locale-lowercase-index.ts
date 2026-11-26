export type LocaleLowercaseIndex = {
  text: string
  originalStartByNormalizedOffset: number[] | null
  originalEndByNormalizedOffset: number[] | null
}

export function buildContextualLocaleLowercaseIndex(original: string): LocaleLowercaseIndex {
  const text = original.toLocaleLowerCase()
  if (text.length === original.length) {
    return { text, originalStartByNormalizedOffset: null, originalEndByNormalizedOffset: null }
  }

  const starts: number[] = []
  const ends: number[] = []
  let offset = 0
  // Contextual length changes stay within a base and its marks; final sigma changes only shape.
  for (const [run] of original.matchAll(/[\s\S]\p{M}*/gu)) {
    const characters = Array.from(run)
    const lengths = characters.map((character) => character.toLocaleLowerCase().length)
    let difference =
      run.toLocaleLowerCase().length - lengths.reduce((sum, length) => sum + length, 0)
    // Lithuanian can insert a dot after the base; Turkish/Azeri can remove its following dot.
    if (difference > 0) {
      lengths[0] += difference
    }
    for (const [index, character] of characters.entries()) {
      let length = lengths[index]
      if (difference < 0 && character === '\u0307') {
        length += difference
        difference = 0
      }
      const end = offset + character.length
      for (let unit = 0; unit < length; unit++) {
        starts.push(offset)
        ends.push(end)
      }
      offset = end
    }
  }
  return { text, originalStartByNormalizedOffset: starts, originalEndByNormalizedOffset: ends }
}

export function buildLocaleLowercaseIndex(text: string): LocaleLowercaseIndex {
  // ASCII has no contextual casing or multi-unit characters, so every offset stays identical.
  if (!/[\u0080-\uffff]/.test(text)) {
    return {
      text: text.toLocaleLowerCase(),
      originalStartByNormalizedOffset: null,
      originalEndByNormalizedOffset: null
    }
  }

  let normalized = ''
  let originalStartByNormalizedOffset: number[] | null = null
  let originalEndByNormalizedOffset: number[] | null = null
  let originalOffset = 0

  for (const char of text) {
    const normalizedChar = char.toLocaleLowerCase()
    const originalEnd = originalOffset + char.length
    if (!originalStartByNormalizedOffset && (char.length !== 1 || normalizedChar.length !== 1)) {
      originalStartByNormalizedOffset = Array.from({ length: originalOffset }, (_, index) => index)
      originalEndByNormalizedOffset = Array.from(
        { length: originalOffset },
        (_, index) => index + 1
      )
    }
    // Locale folding can expand UTF-16 (İ → i + combining dot); map normalized matches back to original DOM offsets.
    for (let i = 0; i < normalizedChar.length; i += 1) {
      originalStartByNormalizedOffset?.push(originalOffset)
      originalEndByNormalizedOffset?.push(originalEnd)
    }
    normalized += normalizedChar
    originalOffset = originalEnd
  }

  return {
    text: normalized,
    originalStartByNormalizedOffset,
    originalEndByNormalizedOffset
  }
}

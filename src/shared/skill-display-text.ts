// Strip spoofing controls/zero-width/bidi codepoints with one predicate so host labels and renderer pickers agree.
export function isSafeDisplayCharacter(character: string): boolean {
  const code = character.codePointAt(0) ?? 0
  return !(
    code <= 0x1f ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x200b ||
    code === 0x200e ||
    code === 0x200f ||
    code === 0x061c ||
    code === 0x2060 ||
    code === 0xfeff ||
    code === 0x2028 ||
    code === 0x2029 ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  )
}

export function stripUnsafeDisplayCharacters(value: string): string {
  return [...value].filter(isSafeDisplayCharacter).join('')
}

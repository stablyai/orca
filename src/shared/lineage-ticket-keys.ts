export function matchesTicketKeys(name: string, keys: string[]): boolean {
  const haystack = name.toLowerCase()
  return keys.some((key) => {
    const needle = key.toLowerCase()
    let from = 0
    for (;;) {
      const at = haystack.indexOf(needle, from)
      if (at === -1) {
        return false
      }
      const before = haystack[at - 1]
      const after = haystack[at + needle.length]
      // invariant: a key only counts as a whole token, so LEVGP-48 never matches LEVGP-483
      if (!(before && /[a-z0-9]/.test(before)) && !(after && /[0-9]/.test(after))) {
        return true
      }
      from = at + 1
    }
  })
}

export const MAX_KEY_REGEX_LENGTH = 200
export const MAX_TOWER_NAME_LENGTH = 500

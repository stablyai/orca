// Address headers per RFC 5322: display names may be quoted (with \-escapes) and hold commas, @ and
// <; (comments) and <angle-addrs> may hold commas too. Only the angle-addr, or a bare address, is real.

// `blank`: nothing but whitespace and comments; `unclosed`: a quote, comment or <...> never ends.
type Scanned = { outside: string; lastAngle: string | null; blank: boolean; unclosed: boolean }

// Walks one header, dropping comments, keeping quoted text where it stands, and calling `at` for
// each char outside quotes, comments and angle brackets.
function scan(text: string, at?: (index: number) => void): Scanned {
  let outside = ''
  let lastAngle: string | null = null
  let angle: string | null = null
  let quoted = false
  let comment = 0
  let blank = true
  const keep = (part: string) => {
    if (angle === null) {
      outside += part
    } else {
      angle += part
    }
  }
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (comment === 0 && char !== '(' && char.trim()) {
      blank = false
    }
    if (comment > 0) {
      if (char === '\\') {
        i += 1
      } else {
        comment += char === '(' ? 1 : char === ')' ? -1 : 0
      }
    } else if (quoted) {
      if (char === '\\') {
        keep(text.slice(i, i + 2))
        i += 1
      } else {
        keep(char)
        quoted = char !== '"'
      }
    } else if (char === '(') {
      comment = 1
    } else if (char === '"') {
      quoted = true
      keep(char)
    } else if (angle !== null) {
      if (char === '>') {
        lastAngle = angle
        angle = null
      } else {
        angle += char
      }
    } else if (char === '<') {
      angle = ''
    } else {
      outside += char
      at?.(i)
    }
  }
  return { outside, lastAngle, blank, unclosed: quoted || comment > 0 || angle !== null }
}

/** A comma-separated address list, commas inside quoted names kept: `"Lee, Kim" <lk@x.com>, a@x.com`. */
export function splitAddresses(header: string | undefined): string[] {
  const text = header ?? ''
  const entries: string[] = []
  let start = 0
  scan(text, (index) => {
    if (text[index] === ',') {
      entries.push(text.slice(start, index))
      start = index + 1
    }
  })
  entries.push(text.slice(start))
  // RFC 5322 allows empty and comment-only entries; they name no one.
  return entries.map((entry) => entry.trim()).filter((entry) => !scan(entry).blank)
}

/**
 * One mailbox's real address, lowercased: inside its last `<...>`, else the bare address. Never
 * from the display name, so `"boss@x.com" <eve@x.com>` is eve@x.com.
 */
export function mailboxAddress(entry: string): string | null {
  const { outside, lastAngle, unclosed } = scan(entry)
  if (unclosed) {
    return null
  }
  // A group (`team: a@x.com;`) prefixes its name; an obsolete route (`<@relay:a@x.com>`) its hops.
  const raw = lastAngle ?? outside.replace(/;\s*$/, '')
  const address = raw
    .slice(raw.lastIndexOf(':') + 1)
    .trim()
    .toLowerCase()
  return /^[^\s@]+@[^\s@"]+$/.test(address) ? address : null
}

/** The real addresses in an address header, lowercased. */
export function mailboxAddresses(header: string | undefined): string[] {
  return splitAddresses(header).flatMap((entry) => mailboxAddress(entry) ?? [])
}

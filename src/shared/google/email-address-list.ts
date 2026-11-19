// Address headers per RFC 5322: display names may be quoted (with \-escapes) and hold commas, @ and
// <; (comments) and <angle-addrs> may hold commas too. Only the angle-addr, or a bare address, is real.

type Scanned = { outside: string; lastAngle: string | null }

// Walks one header, calling `at` for each char outside quotes, comments and angle brackets.
function scan(text: string, at?: (index: number) => void): Scanned {
  let outside = ''
  let lastAngle: string | null = null
  let angle: string | null = null
  let quoted = false
  let comment = 0
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (char === '\\' && (quoted || comment > 0)) {
      i += 1
      continue
    }
    if (quoted) {
      quoted = char !== '"'
    } else if (comment > 0) {
      comment += char === '(' ? 1 : char === ')' ? -1 : 0
    } else if (angle !== null) {
      if (char === '>') {
        lastAngle = angle
        angle = null
      } else {
        angle += char
      }
    } else if (char === '"') {
      quoted = true
    } else if (char === '(') {
      comment = 1
    } else if (char === '<') {
      angle = ''
    } else {
      outside += char
      at?.(i)
    }
  }
  return { outside, lastAngle }
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
  return entries.map((entry) => entry.trim()).filter((entry) => entry.length > 0)
}

/**
 * One mailbox's real address, lowercased: inside its last `<...>`, else the bare address. Never
 * from the display name, so `"boss@x.com" <eve@x.com>` is eve@x.com.
 */
export function mailboxAddress(entry: string): string | null {
  const { outside, lastAngle } = scan(entry)
  // A group (`team: a@x.com;`) prefixes its name; an obsolete route (`<@relay:a@x.com>`) its hops.
  const raw = lastAngle ?? outside.replace(/;\s*$/, '')
  const address = raw
    .slice(raw.lastIndexOf(':') + 1)
    .trim()
    .toLowerCase()
  return /^[^\s@]+@[^\s@]+$/.test(address) ? address : null
}

/** The real addresses in an address header, lowercased. */
export function mailboxAddresses(header: string | undefined): string[] {
  return splitAddresses(header).flatMap((entry) => mailboxAddress(entry) ?? [])
}

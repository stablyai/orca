export type PullRequestRef = { forgeHost: string; owner: string; repo: string; number: number }
export type RepoKey = string
export const repoKey = (ref: Omit<PullRequestRef, 'number'>): RepoKey =>
  `${ref.forgeHost}/${ref.owner}/${ref.repo}`
export const refKey = (ref: PullRequestRef): string => `${repoKey(ref)}#${ref.number}`
/** owner/repo, prefixed with the forge host when it is not github.com so host identity is visible. */
export const displayPrRepo = (ref: Omit<PullRequestRef, 'number'>): string =>
  `${ref.forgeHost === 'github.com' ? '' : `${ref.forgeHost}/`}${ref.owner}/${ref.repo}`

export function bareSpecRefMatches(
  n: number,
  ref: PullRequestRef,
  scope: { hostRepos: ReadonlySet<RepoKey>; primaryRepos: ReadonlySet<RepoKey> }
): boolean {
  return n === ref.number && scope.hostRepos.has(repoKey(ref))
}

export function boundedUtf8(text: string, budget: number): { text: string; truncated: boolean } {
  const prefix = text.slice(0, budget)
  if (/^[\p{ASCII}]*$/u.test(prefix)) {
    return { text: prefix, truncated: prefix.length < text.length }
  }
  const bytes = new TextEncoder().encode(prefix)
  if (bytes.length <= budget) {
    return { text: prefix, truncated: prefix.length < text.length }
  }
  const decoder = new TextDecoder('utf-8', { fatal: true })
  for (let end = budget; end >= Math.max(0, budget - 3); end--) {
    try {
      return { text: decoder.decode(bytes.subarray(0, end)), truncated: true }
    } catch {
      continue
    }
  }
  return { text: '', truncated: true }
}

// Report scanning and spec matching share these boundaries so neither side accepts a token the other rejects.
const URL_TOKEN = String.raw`https?:\/\/[^\s<>"\x60()[\]{}]+`
const BEFORE_SHORT = String.raw`(?<![\p{L}\p{N}_/.#-])`
const AFTER_NUMBER = String.raw`(?![\p{L}\p{N}_-]|\.[\p{L}\p{N}])`
const URL_TOKEN_AT = new RegExp(URL_TOKEN, 'iy')
const URL_TOKEN_TAIL = new RegExp(`${URL_TOKEN}$`, 'i')
const SHORT_TAIL = new RegExp(
  `${BEFORE_SHORT}([A-Za-z0-9][A-Za-z0-9-]*)\\/([A-Za-z0-9_.-]+)#$`,
  'u'
)
const BARE_TAIL = new RegExp(`${BEFORE_SHORT}#$`, 'u')
const REPORT_TOKENS = new RegExp(
  `${URL_TOKEN}|${BEFORE_SHORT}([A-Za-z0-9][A-Za-z0-9-]*)\\/([A-Za-z0-9_.-]+)#([0-9]+)${AFTER_NUMBER}|${BEFORE_SHORT}#([0-9]+)${AFTER_NUMBER}`,
  'giu'
)

function urlRefAt(text: string, index: number, token: string): PullRequestRef | undefined {
  if (index > 0 && !/[\s([{<"'\x60>|*,;:]/.test(text[index - 1]!)) {
    return undefined
  }
  if (/[([{]/.test(text[index + token.length] ?? '')) {
    return undefined
  }
  try {
    const trimmed = token.replace(/[.,;:'!?*]+$/, '')
    const url = new URL(trimmed)
    // Only a path already in its normalized form counts. Dot segments, encoded dots and backslashes
    // could name a PR only after normalization, and report scanning and spec matching both admit
    // URLs here, so a spelling one side cannot see is rejected on both.
    if (/^https?:\/\/[^/?#\\]*([^?#]*)/i.exec(trimmed)?.[1] !== url.pathname) {
      return undefined
    }
    const path = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([0-9]+)(?:\/|$)/.exec(
      url.pathname
    )
    const number = Number(path?.[3])
    if (path && Number.isSafeInteger(number) && number > 0) {
      return {
        forgeHost: url.hostname.toLowerCase(),
        owner: path[1]!.toLowerCase(),
        repo: path[2]!.toLowerCase().replace(/\.git$/, ''),
        number
      }
    }
  } catch {
    /* Invalid URLs cannot establish a PR identity. */
  }
  return undefined
}

export function* scanPrRefs(
  text: string,
  defaultHost: string | undefined,
  hosts: ReadonlySet<string>
): Generator<PullRequestRef | number | 'unknown-host'> {
  const seenTokens = new Set<string>()
  let lastToken: string | undefined
  for (const match of text.matchAll(REPORT_TOKENS)) {
    const isUrl = match[3] === undefined && match[4] === undefined
    const url = isUrl ? urlRefAt(text, match.index, match[0]) : undefined
    if (isUrl && !url) {
      continue
    }
    if (lastToken === match[0] || seenTokens.has(match[0])) {
      continue
    }
    lastToken = match[0]
    seenTokens.add(match[0])
    if (url) {
      if (hosts.has(url.forgeHost)) {
        yield url
      }
    } else {
      const number = Number(match[3] ?? match[4])
      if (!Number.isSafeInteger(number) || number <= 0) {
        continue
      }
      if (match[4]) {
        yield number
      } else if (defaultHost) {
        yield {
          forgeHost: defaultHost,
          owner: match[1]!.toLowerCase(),
          repo: match[2]!.toLowerCase().replace(/\.git$/, ''),
          number
        }
      } else {
        yield 'unknown-host'
      }
    }
  }
}

export function specNamesPr(
  text: string,
  ref: PullRequestRef,
  defaultHost: string | undefined,
  scope: { hostRepos: ReadonlySet<string>; primaryRepos: ReadonlySet<string> }
): boolean | 'unknown' {
  const hits = new RegExp(`(?:#|/pull/)0*${ref.number}${AFTER_NUMBER}`, 'gu')
  let unknown = false
  for (const hit of text.matchAll(hits)) {
    const end = hit.index + hit[0].length - String(ref.number).length
    const start = Math.max(0, end - 512)
    const before = text.slice(start, end).replace(/0+$/, '')
    if (start > 0 && !/\s/.test(before)) {
      unknown = true
      continue
    }
    const url = URL_TOKEN_TAIL.exec(before)
    if (url) {
      if (start > 0 && url.index === 0) {
        unknown = true
        continue
      }
      const position = start + url.index
      URL_TOKEN_AT.lastIndex = position
      const parsed = urlRefAt(text, position, URL_TOKEN_AT.exec(text)![0])
      if (parsed && parsed.number === ref.number && repoKey(parsed) === repoKey(ref)) {
        return true
      }
      continue
    }
    const short = SHORT_TAIL.exec(before)
    if (short) {
      if (start > 0 && short.index === 0) {
        unknown = true
        continue
      }
      if (
        short[1]!.toLowerCase() === ref.owner &&
        short[2]!.toLowerCase().replace(/\.git$/, '') === ref.repo
      ) {
        if (!defaultHost) {
          unknown = true
        } else if (defaultHost === ref.forgeHost) {
          return true
        }
      }
      continue
    }
    if (BARE_TAIL.test(before) && bareSpecRefMatches(ref.number, ref, scope)) {
      return true
    }
  }
  return unknown ? 'unknown' : false
}

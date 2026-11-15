export type PullRequestRef = { forgeHost: string; owner: string; repo: string; number: number }
export type RepoKey = string
export const repoKey = (ref: Omit<PullRequestRef, 'number'>): RepoKey =>
  `${ref.forgeHost}/${ref.owner}/${ref.repo}`
export const refKey = (ref: PullRequestRef): string => `${repoKey(ref)}#${ref.number}`
export const displayPrRef = (ref: PullRequestRef): string =>
  `${ref.forgeHost === 'github.com' ? '' : `${ref.forgeHost}/`}${ref.owner}/${ref.repo}#${ref.number}`

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

export function* scanPrRefs(
  text: string,
  defaultHost: string | undefined,
  hosts: ReadonlySet<string>
): Generator<PullRequestRef | number | 'unknown-host'> {
  const tokens =
    /https?:\/\/[^\s<>"`]+|(?<![\w/.#-])([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9_.-]+)#([0-9]+)(?![\w])|(?<![\w/.#-])#([0-9]+)(?![\w])/g
  const seenTokens = new Set<string>()
  let lastToken: string | undefined
  for (const match of text.matchAll(tokens)) {
    if (lastToken === match[0] || seenTokens.has(match[0])) {
      continue
    }
    lastToken = match[0]
    seenTokens.add(match[0])
    if (match[0].startsWith('http')) {
      try {
        const url = new URL(match[0].replace(/[),.;]+$/, ''))
        const path = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([0-9]+)(?:\/|$)/.exec(
          url.pathname
        )
        if (!path || !hosts.has(url.hostname.toLowerCase())) {
          continue
        }
        const number = Number(path[3])
        if (Number.isSafeInteger(number) && number > 0) {
          yield {
            forgeHost: url.hostname.toLowerCase(),
            owner: path[1]!.toLowerCase(),
            repo: path[2]!.toLowerCase().replace(/\.git$/, ''),
            number
          }
        }
      } catch {
        /* Invalid URLs cannot establish a PR identity. */
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
  const hits = new RegExp(`(?:#|/pull/)0*${ref.number}(?![\\w])`, 'g')
  let unknown = false
  for (const hit of text.matchAll(hits)) {
    const end = hit.index + hit[0].length - String(ref.number).length
    const start = Math.max(0, end - 512)
    const before = text.slice(start, end).replace(/0+$/, '')
    if (start > 0 && !/\s/.test(before)) {
      unknown = true
      continue
    }
    const url = /https?:\/\/([^/\s<>"`]+)\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/$/i.exec(
      before
    )
    if (url) {
      if (start > 0 && url.index === 0) {
        unknown = true
        continue
      }
      if (
        `${new URL(url[0]).hostname.toLowerCase()}/${url[2]!.toLowerCase()}/${url[3]!.toLowerCase().replace(/\.git$/, '')}` ===
        repoKey(ref)
      ) {
        return true
      }
      continue
    }
    if (/https?:\/\/[^\s<>"`]*$/i.test(before)) {
      continue
    }
    const short = /(?<![\w/.#-])([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9_.-]+)#$/i.exec(before)
    if (short) {
      if (start > 0 && short.index === 0) {
        unknown = true
        continue
      }
      if (
        `${defaultHost}/${short[1]!.toLowerCase()}/${short[2]!.toLowerCase().replace(/\.git$/, '')}` ===
        repoKey(ref)
      ) {
        return true
      }
      continue
    }
    if (/(?<![\w/.#-])#$/.test(before) && bareSpecRefMatches(ref.number, ref, scope)) {
      return true
    }
  }
  return unknown ? 'unknown' : false
}

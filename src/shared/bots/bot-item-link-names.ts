// A linked thing's short name, as an item's Links rows and chat lines show it: a GitHub PR or issue as
// #n (its repo only when it isn't the item's), a Linear issue as its key, a URL as its host, a file as
// its name, a worker as its task title.
import { botItemPrRefOfUrl, parseBotItemPrRef, type BotItemLinkView } from './bot-items'

const GITHUB_PATH = /^\/([\w.-]+\/[\w.-]+)\/(pull|issues)\/(\d+)/
const LINEAR_PATH = /^\/[^/]+\/issue\/([A-Za-z0-9]+-\d+)/

function parsedUrl(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}

/** A github.com PR or issue URL's repo and number; null for anything else. */
export function botItemGitHubRefOfUrl(
  url: string
): { type: 'pr' | 'issue'; repo: string; number: number } | null {
  const parsed = parsedUrl(url)
  const match =
    parsed && /^(www\.)?github\.com$/i.test(parsed.hostname)
      ? GITHUB_PATH.exec(parsed.pathname)
      : null
  return match
    ? { type: match[2] === 'pull' ? 'pr' : 'issue', repo: match[1]!, number: Number(match[3]) }
    : null
}

/** The host without `www.`; empty for a URL that doesn't parse. */
export function botItemUrlHost(url: string): string {
  return (
    parsedUrl(url)
      ?.hostname.toLowerCase()
      .replace(/^www\./, '') ?? ''
  )
}

/** A Linear issue URL's key, upper-cased; null for anything else. */
export function botItemLinearKeyOfUrl(url: string): string | null {
  const parsed = parsedUrl(url)
  if (!parsed || !/(^|\.)linear\.app$/.test(botItemUrlHost(url))) {
    return null
  }
  return LINEAR_PATH.exec(parsed.pathname)?.[1]?.toUpperCase() ?? null
}

export function botItemFileName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return cut >= 0 ? trimmed.slice(cut + 1) : trimmed
}

/** The item's repo: the one most of its GitHub links share (the first on a tie), lower-cased. */
export function botItemHomeRepo(repos: readonly string[]): string | null {
  const counts = new Map<string, number>()
  for (const repo of repos) {
    counts.set(repo.toLowerCase(), (counts.get(repo.toLowerCase()) ?? 0) + 1)
  }
  let home: string | null = null
  for (const [repo, count] of counts) {
    if (home === null || count > counts.get(home)!) {
      home = repo
    }
  }
  return home
}

/** A linked PR's `owner/repo#n`, however it was linked; null for anything else. */
function prRefOf(link: BotItemLinkView): string | null {
  switch (link.kind) {
    case 'dispatch':
      return link.pr?.shown ? (botItemPrRefOfUrl(link.pr.url) ?? link.pr.ref) : null
    case 'pr':
      return link.pr
        ? link.pr.shown
          ? (botItemPrRefOfUrl(link.pr.url) ?? link.pr.ref)
          : null
        : link.ref
    case 'url':
      return botItemPrRefOfUrl(link.ref)
    case 'file':
    case 'automation':
      return null
  }
}

/** The repo of each GitHub PR or issue an item links, each one once however it was linked. */
function linkedRepos(links: readonly BotItemLinkView[]): string[] {
  const repos = new Map<string, string>()
  for (const link of links) {
    const pr = prRefOf(link)
    const issue = !pr && link.kind === 'url' ? botItemGitHubRefOfUrl(link.ref) : null
    if (pr) {
      repos.set(`pr:${pr.trim().toLowerCase()}`, pr.split('#')[0]!)
    } else if (issue) {
      repos.set(`${issue.type}:${issue.repo}#${issue.number}`.toLowerCase(), issue.repo)
    }
  }
  return [...repos.values()]
}

type NameContext = {
  homeRepo: string | null
  workerTitle: (dispatchId: string) => string | null
  automationName?: (automationId: string) => string | null
}

function githubName(repo: string, number: number, homeRepo: string | null): string {
  return homeRepo !== null && repo.toLowerCase() !== homeRepo ? `${repo}#${number}` : `#${number}`
}

/** A stored link (`kind:ref`) by its short name; null for a worker whose title isn't known. Without
 *  the item's links (`homeRepo` null), a PR or issue reads #n. */
export function botItemLinkName(word: string, context: NameContext): string | null {
  const cut = word.indexOf(':')
  const kind = word.slice(0, cut)
  const ref = word.slice(cut + 1)
  switch (kind) {
    case 'dispatch':
      return context.workerTitle(ref)
    case 'pr': {
      const pr = parseBotItemPrRef(ref)
      return pr ? githubName(pr.repo, pr.number, context.homeRepo) : ref
    }
    case 'url': {
      const github = botItemGitHubRefOfUrl(ref)
      if (github) {
        return githubName(github.repo, github.number, context.homeRepo)
      }
      return botItemLinearKeyOfUrl(ref) ?? (botItemUrlHost(ref) || ref)
    }
    case 'file':
      return botItemFileName(ref)
    case 'automation':
      return context.automationName?.(ref) ?? null
    default:
      return word
  }
}

/** Short names for an item's new links, read against all its links; a worker with no title is left out. */
export function botItemLinkNames(
  words: readonly string[],
  links: readonly BotItemLinkView[]
): Record<string, string> {
  const context: NameContext = {
    homeRepo: botItemHomeRepo(linkedRepos(links)),
    workerTitle: (id) => {
      const worker = links.find((link) => link.kind === 'dispatch' && link.ref === id)
      return (worker?.kind === 'dispatch' && worker.title?.trim()) || null
    },
    automationName: (id) => {
      const automation = links.find((link) => link.kind === 'automation' && link.ref === id)
      return (automation?.kind === 'automation' && automation.name?.trim()) || null
    }
  }
  const names: Record<string, string> = {}
  for (const word of words) {
    const name = botItemLinkName(word, context)
    if (name) {
      names[word] = name
    }
  }
  return names
}

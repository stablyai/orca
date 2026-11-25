import { buildGitHubRepoUrl, parseGitHubIssueOrPRLink, type RepoSlug } from './links'

export type IssueRepository = Pick<RepoSlug, 'owner' | 'repo'>
type BareIssueReference = { kind: 'bare'; number: number }
type ShorthandIssueReference = IssueRepository & { kind: 'shorthand'; number: number }
type IssueUrl = IssueRepository & { kind: 'url'; host: string; number: number; url: string }
type IssueReference = BareIssueReference | ShorthandIssueReference | IssueUrl

type IssueReferenceContext = {
  host?: string
  defaultIssueRepository?: IssueRepository | null
}

const SHORTHAND = /^([^/]+)\/([^/#]+)#(\d+)$/
const OWNER = /^[a-z\d]+(?:-[a-z\d]+)*$/i
const REPOSITORY = /^[a-z\d_.-]{1,100}$/i

function parseIssueNumber(digits: string): number | null {
  const number = Number(digits)
  return Number.isSafeInteger(number) && number > 0 ? number : null
}

function isIssueRepository(owner: string, repo: string): boolean {
  return (
    owner.length <= 39 &&
    OWNER.test(owner) &&
    REPOSITORY.test(repo) &&
    repo !== '.' &&
    repo !== '..'
  )
}

export function parseIssueRepository(input: string): IssueRepository | undefined {
  const [owner, repo, ...rest] = input.trim().split('/')
  return repo && rest.length === 0 && isIssueRepository(owner, repo) ? { owner, repo } : undefined
}

export function normalizeIssueRepository(value: unknown): IssueRepository | null | undefined {
  if (value === null) {
    return null
  }
  if (!value || typeof value !== 'object' || !('owner' in value) || !('repo' in value)) {
    return undefined
  }
  const owner = typeof value.owner === 'string' ? value.owner.trim() : ''
  const repo = typeof value.repo === 'string' ? value.repo.trim() : ''
  return isIssueRepository(owner, repo) ? { owner, repo } : undefined
}

export function parseGitHubIssueReference(input: string): IssueReference | null {
  const value = input.trim()
  const bare = /^#?(\d+)$/.exec(value)
  if (bare) {
    const number = parseIssueNumber(bare[1])
    return number === null ? null : { kind: 'bare', number }
  }
  const match = SHORTHAND.exec(value)
  if (!match) {
    return parseIssueUrl(value)
  }
  const [, owner, repo, digits] = match
  const number = parseIssueNumber(digits)
  if (number === null || !isIssueRepository(owner, repo)) {
    return null
  }
  return { kind: 'shorthand', owner, repo, number }
}

function parseIssueUrl(value: string): IssueUrl | null {
  if (!/^https?:\/\//i.test(value)) {
    return null
  }
  const issue = parseGitHubIssueOrPRLink(value)
  if (
    issue?.type !== 'issue' ||
    !issue.slug.host ||
    !isIssueRepository(issue.slug.owner, issue.slug.repo) ||
    !Number.isSafeInteger(issue.number)
  ) {
    return null
  }
  const url = new URL(value)
  if (url.username || url.password) {
    return null
  }
  return {
    kind: 'url',
    owner: issue.slug.owner,
    repo: issue.slug.repo,
    host: issue.slug.host,
    number: issue.number,
    url: value
  }
}

export function resolveGitHubIssueReference(
  reference: IssueReference | null,
  context: IssueReferenceContext
): BareIssueReference | IssueUrl | null {
  if (!reference || reference.kind === 'url') {
    return reference
  }
  const repository = reference.kind === 'bare' ? context.defaultIssueRepository : reference
  if (!repository) {
    return { kind: 'bare', number: reference.number }
  }
  const { owner, repo } = repository
  const { number } = reference
  const host = context.host || 'github.com'
  return {
    kind: 'url',
    owner,
    repo,
    host,
    number,
    url: `${buildGitHubRepoUrl({ owner, repo, host })}/issues/${number}`
  }
}

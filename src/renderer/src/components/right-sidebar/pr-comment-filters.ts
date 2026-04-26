import type { PRComment } from '../../../../shared/types'

export type PRCommentAudienceFilter = 'all' | 'human' | 'bot'

const BOT_LOGIN_SUFFIX = '[bot]'
const AUTOMATION_LOGIN_PATTERNS = [
  /bot$/i,
  /-bot$/i,
  /\bbot\b/i,
  /automation/i,
  /actions/i,
  /renovate/i,
  /dependabot/i
]
// Why: several AI code-review services register as regular GitHub *user*
// accounts rather than GitHub Apps, so REST `user.type` returns "User" and
// their logins don't contain "bot"/"automation" either (qodo-ai-reviewer,
// coderabbitai, codium-ai, etc.). Maintain an explicit allowlist so these
// still land in the Bots tab. Matched as a substring to cover variants
// like `coderabbitai[bot]`, `qodo-ai-reviewer`, `qodo-merge-pro`.
const KNOWN_AUTOMATION_LOGIN_SUBSTRINGS = [
  'qodo',
  'coderabbit',
  'codium',
  'sonarcloud',
  'sonarqube',
  'sourcery-ai',
  'deepsource',
  'snyk',
  'codecov',
  'greptile',
  'ellipsis',
  'graphite-app',
  'reviewer-gpt',
  '-reviewer'
]

export function isAutomatedPRComment(comment: PRComment): boolean {
  // Why: GitHub's REST `user.type === 'Bot'` and GraphQL `author.__typename === 'Bot'`
  // only flag accounts registered as GitHub Apps. Several popular AI reviewers
  // (qodo-ai-reviewer, coderabbitai) sign in as regular *user* accounts, so
  // `isBot` returns false for them. Treat isBot=true as authoritative, but when
  // absent or false, fall through to login heuristics + a known-bot allowlist.
  if (comment.isBot === true) {
    return true
  }
  const author = comment.author.trim()
  const normalized = author.toLowerCase()
  if (normalized.endsWith(BOT_LOGIN_SUFFIX)) {
    return true
  }
  if (KNOWN_AUTOMATION_LOGIN_SUBSTRINGS.some((needle) => normalized.includes(needle))) {
    return true
  }
  return AUTOMATION_LOGIN_PATTERNS.some((pattern) => pattern.test(author))
}

export function filterPRCommentsByAudience(
  comments: PRComment[],
  filter: PRCommentAudienceFilter
): PRComment[] {
  if (filter === 'all') {
    return comments
  }
  return comments.filter((comment) => {
    const automated = isAutomatedPRComment(comment)
    return filter === 'bot' ? automated : !automated
  })
}

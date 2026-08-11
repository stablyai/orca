import type { PRComment } from './types'
import { normalizePRCommentAuthorLogin } from './pr-bot-author-overrides'

export type PRCommentAudienceFilter = 'all' | 'human' | 'bot'

const BOT_LOGIN_SUFFIX = '[bot]'
const AUTOMATION_LOGIN_PATTERNS = [
  /bot$/i,
  /\bbot\b/i,
  /automation/i,
  /actions/i,
  /renovate/i,
  /dependabot/i
]

// GitHub can report regular-account review services as users.
const KNOWN_AUTOMATION_LOGIN_SUBSTRINGS = [
  'chatgpt-codex-connector',
  'codex-connector',
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

export function isBotPRComment(
  comment: PRComment,
  botAuthorOverrides?: ReadonlySet<string>
): boolean {
  const author = comment.author.trim()
  const normalized = normalizePRCommentAuthorLogin(author)
  if (botAuthorOverrides?.has(normalized) || comment.isBot === true) {
    return true
  }
  if (normalized.endsWith(BOT_LOGIN_SUFFIX)) {
    return true
  }
  if (KNOWN_AUTOMATION_LOGIN_SUBSTRINGS.some((needle) => normalized.includes(needle))) {
    return true
  }
  return AUTOMATION_LOGIN_PATTERNS.some((pattern) => pattern.test(author))
}

export function getPRCommentAudienceCounts(
  comments: readonly PRComment[],
  botAuthorOverrides?: ReadonlySet<string>
): Record<PRCommentAudienceFilter, number> {
  const bot = comments.filter((comment) => isBotPRComment(comment, botAuthorOverrides)).length
  return { all: comments.length, human: comments.length - bot, bot }
}

export function filterPRCommentsByAudience(
  comments: PRComment[],
  filter: PRCommentAudienceFilter,
  botAuthorOverrides?: ReadonlySet<string>
): PRComment[] {
  if (filter === 'bot') {
    return comments.filter((comment) => isBotPRComment(comment, botAuthorOverrides))
  }
  if (filter === 'human') {
    return comments.filter((comment) => !isBotPRComment(comment, botAuthorOverrides))
  }
  return comments
}

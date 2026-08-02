import type { PRComment } from '../../../shared/types'
import {
  createBotAuthorOverrideSet,
  normalizePRCommentAuthorLogin
} from '../../../shared/pr-bot-author-overrides'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translate } from '@/i18n/i18n'

export { createBotAuthorOverrideSet, normalizePRCommentAuthorLogin }

export type PRCommentAudienceFilter = 'all' | 'human' | 'bot'

export const getPrCommentAudienceFilters = createLocalizedCatalog(
  (): { value: PRCommentAudienceFilter; label: string }[] => [
    { value: 'all', label: translate('auto.lib.pr.comment.audience.27ce73211c', 'All') },
    { value: 'human', label: translate('auto.lib.pr.comment.audience.a7150a17bc', 'Humans') },
    { value: 'bot', label: translate('auto.lib.pr.comment.audience.64deee36a9', 'Bots') }
  ]
)

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
// Why: some AI/code-review services use regular GitHub user accounts rather
// than GitHub Apps, so GitHub metadata can report them as users. Keep this
// central so the Tasks dialog and PR sidebar classify comments identically.
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
  if (botAuthorOverrides?.has(normalized)) {
    return true
  }
  if (comment.isBot === true) {
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
  comments: PRComment[],
  botAuthorOverrides?: ReadonlySet<string>
): Record<PRCommentAudienceFilter, number> {
  const bot = comments.filter((comment) => isBotPRComment(comment, botAuthorOverrides)).length
  return {
    all: comments.length,
    human: comments.length - bot,
    bot
  }
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

export function getPRCommentAudienceEmptyLabel(filter: PRCommentAudienceFilter): string {
  switch (filter) {
    case 'bot':
      return translate('auto.lib.pr.comment.audience.empty.bot', 'No bot comments.')
    case 'human':
      return translate('auto.lib.pr.comment.audience.empty.human', 'No human comments.')
    case 'all':
      return translate('auto.lib.pr.comment.audience.empty.all', 'No comments yet.')
  }
}

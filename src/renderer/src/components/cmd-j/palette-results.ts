import { translate } from '@/i18n/i18n'
import type { SettingsNavIcon, SettingsNavSection } from '@/lib/settings-navigation-types'
import type { CmdJQuickAction } from './quick-actions'
import { isClipboardTextByteLengthOverLimit } from '../../../../shared/clipboard-text'
import {
  cmdJPaletteTokenScore,
  isCmdJPaletteQueryOverTokenLimit,
  normalizeCmdJPaletteQuery,
  uniqueCmdJPaletteQueryTokens,
  uniqueNormalizedCmdJPaletteKeywords
} from './palette-query-tokens'
import {
  paletteResultQualityClassRank,
  type PaletteResultQualityClass
} from '../../../../shared/palette-match/match-quality'

export type CmdJSettingsResult = {
  id: string
  kind: 'settings'
  title: string
  description: string
  icon: SettingsNavIcon
  sectionId: string
  targetSectionId?: string
  order: number
  configKeywords: string[]
}

export type CmdJActionResult = CmdJQuickAction & {
  order: number
}

export type CmdJMiddleResult = CmdJSettingsResult | CmdJActionResult

/** Ranked row plus the cross-section class that decides which palette section leads. */
export type CmdJRankedMiddleResult = CmdJMiddleResult & {
  qualityClass: PaletteResultQualityClass
}

type RankedResult = {
  result: CmdJMiddleResult
  rule: number
  score: number
}

/** Rules 1-3 need an exact keyword hit, 4-5 only a prefix, 6 is the token-score fallback. */
function middleRuleQualityClass(rule: number): PaletteResultQualityClass {
  if (rule <= 3) {
    return 'exact-intent'
  }
  return rule <= 5 ? 'visible-prefix' : 'partial-evidence'
}

/** Strongest class in an already-ranked section, or null when the section is empty. */
export function bestCmdJPaletteSectionQualityClass(
  results: readonly { qualityClass: PaletteResultQualityClass }[]
): PaletteResultQualityClass | null {
  let best: PaletteResultQualityClass | null = null
  for (const { qualityClass } of results) {
    if (
      best === null ||
      paletteResultQualityClassRank(qualityClass) < paletteResultQualityClassRank(best)
    ) {
      best = qualityClass
    }
  }
  return best
}

const SETTINGS_ALIASES: Record<string, string[]> = {
  browser: ['browser settings'],
  terminal: ['terminal settings'],
  ssh: ['ssh'],
  shortcuts: ['keyboard shortcuts'],
  appearance: ['theme', 'themes'],
  agents: ['ai agents'],
  'quick-commands': ['quick commands', 'quick command'],
  repo: ['repository settings', 'project settings'],
  integrations: ['gitlab', 'github', 'linear'],
  notifications: ['notification settings'],
  mobile: ['phone'],
  voice: ['dictation'],
  'computer-use': ['computer use'],
  stats: ['usage'],
  privacy: ['telemetry']
}

export const CMD_J_PALETTE_QUERY_MAX_BYTES = 2 * 1024

export function isCmdJPaletteQueryTooLarge(
  query: string,
  maxBytes = CMD_J_PALETTE_QUERY_MAX_BYTES
): boolean {
  return isClipboardTextByteLengthOverLimit(query, maxBytes)
}

// Translate at call time; localized users can search the same Settings word displayed on row badges.
function settingsWord(): string {
  return translate('auto.components.WorktreeJumpPalette.settingsBadge', 'Settings').toLowerCase()
}

function keywordParts(section: SettingsNavSection): string[] {
  const baseId = section.id.startsWith('repo-') ? 'repo' : section.id
  const idWords = baseId.replace(/-/g, ' ')
  const paneLevelEntries = section.searchEntries.filter((entry) => !entry.targetSectionId)
  const localized = settingsWord()
  // Keep English aliases too; catalog titles may remain English and users can still type English queries.
  const suffixed = [`${section.title} settings`, `${idWords} settings`]
  if (localized !== 'settings') {
    suffixed.push(`${section.title} ${localized}`, `${idWords} ${localized}`, localized)
  }
  return [
    section.id,
    baseId,
    idWords,
    section.title,
    ...suffixed,
    ...(SETTINGS_ALIASES[baseId] ?? []),
    ...paneLevelEntries.map((entry) => entry.title)
  ]
}

function targetEntryKeywordParts(entryTitle: string): string[] {
  const localized = settingsWord()
  const parts = [entryTitle, `${entryTitle} settings`]
  if (localized !== 'settings') {
    parts.push(`${entryTitle} ${localized}`)
  }
  return parts
}

export function buildCmdJSettingsResults(
  sections: readonly SettingsNavSection[]
): CmdJSettingsResult[] {
  return sections.flatMap((section, order) => {
    const paneResult: CmdJSettingsResult = {
      id: `settings:${section.id}`,
      kind: 'settings',
      title: section.title,
      description: section.description,
      icon: section.icon,
      sectionId: section.id,
      order,
      configKeywords: uniqueNormalizedCmdJPaletteKeywords(keywordParts(section))
    }
    const targetedResults = section.searchEntries
      .filter((entry) => entry.targetSectionId)
      .map((entry, entryIndex) => ({
        id: `settings:${section.id}:${entry.targetSectionId}`,
        kind: 'settings' as const,
        title: entry.title,
        description: entry.description ?? section.description,
        icon: section.icon,
        sectionId: section.id,
        targetSectionId: entry.targetSectionId,
        order: order + (entryIndex + 1) / 100,
        configKeywords: uniqueNormalizedCmdJPaletteKeywords([
          ...targetEntryKeywordParts(entry.title),
          ...(entry.cmdJKeywords ?? entry.keywords ?? [])
        ])
      }))

    return [paneResult, ...targetedResults]
  })
}

export function buildCmdJActionResults(actions: readonly CmdJQuickAction[]): CmdJActionResult[] {
  // Fold keywords like queries or raw-cased commands miss exact intent and sink below workspace prefixes.
  return actions.map((action, order) => ({
    ...action,
    order,
    verbKeywords: uniqueNormalizedCmdJPaletteKeywords(action.verbKeywords)
  }))
}

function startsOrIsStartedBy(query: string, keyword: string): boolean {
  return keyword.startsWith(query) || query.startsWith(keyword)
}

function rankingForCandidate(
  query: string,
  queryTokens: readonly string[],
  candidate: CmdJMiddleResult,
  actionVerbKeywords: readonly string[],
  settingsConfigKeywords: readonly string[]
): RankedResult | null {
  if (!query) {
    return null
  }

  // Gate head/tail shortcut rules on full coverage so unmatched middle words cannot produce exact intent.
  const values =
    candidate.kind === 'settings'
      ? [candidate.title, ...candidate.configKeywords]
      : [candidate.title, ...candidate.verbKeywords]
  const score = cmdJPaletteTokenScore(queryTokens, values)
  if (score === 0) {
    return null
  }

  if (candidate.kind === 'action' && candidate.verbKeywords.some((keyword) => query === keyword)) {
    return { result: candidate, rule: 1, score: 0 }
  }

  if (
    candidate.kind === 'settings' &&
    candidate.configKeywords.some((keyword) => query === keyword)
  ) {
    return { result: candidate, rule: 2, score: 0 }
  }

  if (
    candidate.kind === 'settings' &&
    actionVerbKeywords.some((keyword) => query.startsWith(keyword)) &&
    candidate.configKeywords.some((keyword) => query.endsWith(keyword))
  ) {
    return { result: candidate, rule: 3, score: 0 }
  }

  if (
    candidate.kind === 'action' &&
    candidate.verbKeywords.some((keyword) => startsOrIsStartedBy(query, keyword)) &&
    !settingsConfigKeywords.some((keyword) => query.endsWith(keyword))
  ) {
    return { result: candidate, rule: 4, score: 0 }
  }

  if (
    candidate.kind === 'settings' &&
    candidate.configKeywords.some((keyword) => keyword.startsWith(query) && keyword !== query)
  ) {
    return { result: candidate, rule: 5, score: 0 }
  }

  return { result: candidate, rule: 6, score }
}

function compareRanked(a: RankedResult, b: RankedResult): number {
  if (a.rule !== b.rule) {
    return a.rule - b.rule
  }
  if (a.rule === 6 && a.score !== b.score) {
    return b.score - a.score
  }
  if (a.result.kind !== b.result.kind) {
    return a.result.kind === 'settings' ? -1 : 1
  }
  if (a.result.order !== b.result.order) {
    return a.result.order - b.result.order
  }
  return a.result.id.localeCompare(b.result.id)
}

export function rankCmdJMiddleResults({
  query,
  settingsResults,
  actionResults
}: {
  query: string
  settingsResults: readonly CmdJSettingsResult[]
  actionResults: readonly CmdJActionResult[]
}): CmdJRankedMiddleResult[] {
  if (isCmdJPaletteQueryTooLarge(query)) {
    return []
  }
  const normalizedQuery = normalizeCmdJPaletteQuery(query)
  if (normalizedQuery.length < 2 || isCmdJPaletteQueryOverTokenLimit(normalizedQuery)) {
    return []
  }
  const queryTokens = uniqueCmdJPaletteQueryTokens(normalizedQuery)
  const settings = settingsResults
  const actions = actionResults
  const actionVerbKeywords = actions.flatMap((action) => action.verbKeywords)
  const settingsConfigKeywords = settings.flatMap((setting) => setting.configKeywords)

  return [...settings, ...actions]
    .map((candidate) =>
      rankingForCandidate(
        normalizedQuery,
        queryTokens,
        candidate,
        actionVerbKeywords,
        settingsConfigKeywords
      )
    )
    .filter((entry): entry is RankedResult => entry !== null)
    .sort(compareRanked)
    .map((entry) => ({ ...entry.result, qualityClass: middleRuleQualityClass(entry.rule) }))
}

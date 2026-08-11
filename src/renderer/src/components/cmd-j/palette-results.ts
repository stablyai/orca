import type { SettingsNavIcon, SettingsNavSection } from '@/lib/settings-navigation-types'
import type { CmdJQuickAction } from './quick-actions'
import { isClipboardTextByteLengthOverLimit } from '../../../../shared/clipboard-text'
import {
  cmdJPaletteTokenScore,
  normalizeCmdJPaletteQuery,
  uniqueNormalizedCmdJPaletteKeywords
} from './palette-query-tokens'

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

type RankedResult = {
  result: CmdJMiddleResult
  rule: number
  score: number
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

function keywordParts(section: SettingsNavSection): string[] {
  const baseId = section.id.startsWith('repo-') ? 'repo' : section.id
  const idWords = baseId.replace(/-/g, ' ')
  const paneLevelEntries = section.searchEntries.filter((entry) => !entry.targetSectionId)
  return [
    section.id,
    baseId,
    idWords,
    section.title,
    `${section.title} settings`,
    `${idWords} settings`,
    ...(SETTINGS_ALIASES[baseId] ?? []),
    ...paneLevelEntries.map((entry) => entry.title)
  ]
}

function targetEntryKeywordParts(entryTitle: string): string[] {
  return [entryTitle, `${entryTitle} settings`]
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
  return actions.map((action, order) => ({ ...action, order }))
}

function startsOrIsStartedBy(query: string, keyword: string): boolean {
  return keyword.startsWith(query) || query.startsWith(keyword)
}

function rankingForCandidate(
  query: string,
  candidate: CmdJMiddleResult,
  actionVerbKeywords: readonly string[],
  settingsConfigKeywords: readonly string[]
): RankedResult | null {
  if (!query) {
    return null
  }

  // Why: the shortcut rules below only inspect the head and tail of the query, so coverage has
  // to gate all of them — otherwise "new terminal <junk> browser settings" still wins on rule 3.
  const values =
    candidate.kind === 'settings'
      ? [candidate.title, ...candidate.configKeywords]
      : [candidate.title, ...candidate.verbKeywords]
  const score = cmdJPaletteTokenScore(query, values)
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
}): CmdJMiddleResult[] {
  if (isCmdJPaletteQueryTooLarge(query)) {
    return []
  }
  const normalizedQuery = normalizeCmdJPaletteQuery(query)
  if (normalizedQuery.length < 2) {
    return []
  }
  const settings = settingsResults
  const actions = actionResults
  const actionVerbKeywords = actions.flatMap((action) => action.verbKeywords)
  const settingsConfigKeywords = settings.flatMap((setting) => setting.configKeywords)

  return [...settings, ...actions]
    .map((candidate) =>
      rankingForCandidate(normalizedQuery, candidate, actionVerbKeywords, settingsConfigKeywords)
    )
    .filter((entry): entry is RankedResult => entry !== null)
    .sort(compareRanked)
    .map((entry) => entry.result)
}

import { useMemo } from 'react'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { BOT_PALETTE_SOURCE_ID } from '@/components/cmd-j/palette-extra-results'
import type { PaletteListEntry } from './worktree-jump-palette-model'
import {
  buildPaletteExtraSectionEntries,
  type VisiblePaletteExtraSection
} from './results/worktree-jump-palette-extra-list-entries'
import { botScopeRecoveryText } from './use-worktree-jump-palette-bot-scope'

export type WorktreeJumpPaletteBotScopeEntries = {
  /** The whole list while showing only bots; null otherwise. */
  botScopeEntries: PaletteListEntry[] | null
  /** Rows after everything else: the offer to search bots a filter hides. */
  botScopeTrailingEntries: readonly PaletteListEntry[]
  /** Muted text above the scoped list saying why it's empty; never a row you can select. */
  botScopeNote: string | null
}

const NO_ENTRIES: readonly PaletteListEntry[] = []

/** What the @ scope adds to the list, for whichever mode the palette is in. */
export function useWorktreeJumpPaletteBotScopeEntries({
  scoped,
  query,
  visibleExtraSections,
  botCatalogSize,
  filterHiddenBotMatches,
  handleExpandSection
}: {
  scoped: boolean
  query: string
  visibleExtraSections: readonly VisiblePaletteExtraSection[]
  botCatalogSize: number
  filterHiddenBotMatches: number
  handleExpandSection: (sectionKey: string) => void
}): WorktreeJumpPaletteBotScopeEntries {
  const t = useTranslate()
  const scopedList = useMemo(
    () =>
      scoped
        ? buildBotScopeEntries({
            visibleExtraSections,
            botCatalogSize,
            query,
            t,
            handleExpandSection
          })
        : null,
    [botCatalogSize, handleExpandSection, query, scoped, t, visibleExtraSections]
  )
  const text = query.trim()
  const botScopeTrailingEntries = useMemo(
    (): readonly PaletteListEntry[] =>
      !scoped && filterHiddenBotMatches > 0 && text
        ? [
            {
              id: '__bot_scope_search_bots__',
              type: 'bot-scope-action',
              action: 'search-bots',
              label: t('bots.palette.searchBotsFor', 'Search bots for "{{text}}"', { text })
            }
          ]
        : NO_ENTRIES,
    [filterHiddenBotMatches, scoped, t, text]
  )
  return {
    botScopeEntries: scopedList?.entries ?? null,
    botScopeNote: scopedList?.note ?? null,
    botScopeTrailingEntries
  }
}

/** The list while showing only bots: the Bots section, why it is empty, and the way back to everything. */
export function buildBotScopeEntries({
  visibleExtraSections,
  botCatalogSize,
  query,
  t,
  handleExpandSection
}: {
  visibleExtraSections: readonly VisiblePaletteExtraSection[]
  botCatalogSize: number
  query: string
  t: Translate
  handleExpandSection: (sectionKey: string) => void
}): { entries: PaletteListEntry[]; note: string | null } {
  const entries: PaletteListEntry[] = []
  let note: string | null = null
  const text = query.trim()
  if (botCatalogSize === 0) {
    entries.push({
      id: '__bot_scope_browse_templates__',
      type: 'bot-scope-action',
      action: 'browse-templates',
      label: t('bots.templates.browse', 'Browse templates')
    })
    return { entries, note: t('bots.palette.noBotsYet', 'No bots yet') }
  }
  const botSections = visibleExtraSections.filter(
    (section) => section.source.id === BOT_PALETTE_SOURCE_ID
  )
  const botEntries = buildPaletteExtraSectionEntries(
    botSections,
    { emptyQuery: botSections[0]?.source.emptyQueryPlacement ?? 'last' },
    t,
    handleExpandSection
  )
  if (botEntries.length > 0) {
    entries.push(...botEntries)
  } else if (text) {
    // No empty header: the note says why the list is empty, the row below is the way out.
    note = t('bots.palette.noMatch', 'No bots match "{{text}}"', { text })
  }
  if (text) {
    entries.push({
      id: '__bot_scope_show_everything__',
      type: 'bot-scope-action',
      action: 'show-everything',
      label: t('bots.palette.searchEverything', 'Search everything for "{{text}}"', {
        text: botScopeRecoveryText(query)
      })
    })
  }
  return { entries, note }
}

import type { Translate } from '@/i18n/use-translate'
import type { PaletteExtraSource } from '@/components/cmd-j/palette-extra-results'
import type { PaletteItem, PaletteListEntry } from './worktree-jump-palette-model'

export type VisiblePaletteExtraSection = {
  source: PaletteExtraSource
  visible: readonly PaletteItem[]
  overflowCount: number
  leads: boolean
}

/** 'all' is the empty query; typed queries place each section by leadership, then its placement hint. */
export type PaletteExtraSlot = 'all' | 'leading' | PaletteExtraSource['typedPlacement']

export function buildPaletteExtraSectionEntries(
  sections: readonly VisiblePaletteExtraSection[],
  slot: PaletteExtraSlot,
  t: Translate,
  onExpandSection: (sectionKey: string) => void
): PaletteListEntry[] {
  const entries: PaletteListEntry[] = []
  for (const { source, visible, overflowCount, leads } of sections) {
    const inSlot =
      slot === 'all' || (slot === 'leading' ? leads : !leads && source.typedPlacement === slot)
    if (!inSlot || visible.length === 0) {
      continue
    }
    entries.push({
      id: `__header_extra_${source.id}__`,
      type: 'section-header',
      label: source.sectionLabel(t)
    })
    entries.push(...visible)
    if (overflowCount > 0) {
      entries.push({
        id: `__hint_extra_${source.id}_overflow__`,
        type: 'hint',
        label: t('worktreeJumpPalette.renderCapOverflow', '{{value0}} more', {
          value0: overflowCount
        }),
        onSeeMore: () => onExpandSection(`extra:${source.id}`)
      })
    }
  }
  return entries
}

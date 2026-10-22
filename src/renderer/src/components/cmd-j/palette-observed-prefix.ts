import { translate } from '@/i18n/i18n'
import type {
  PaletteItem,
  PaletteListEntry,
  PaletteSectionKey,
  SectionHeader
} from '../worktree-jump-palette-model'
import { buildPaletteListEntryRenderKeys } from './palette-list-entry-render-keys'

export type PaletteObservedOccurrence = {
  key: string
  id: string
} & (
  | { type: 'section-header' | 'hint'; section: PaletteSectionKey; label: string }
  | { type: PaletteItem['type'] | 'create-worktree'; section: PaletteSectionKey | null }
)

export function paletteEntrySection(entry: PaletteListEntry): PaletteSectionKey | null {
  switch (entry.type) {
    case 'browser-page':
    case 'simulator-tab':
    case 'workspace-tab':
      return 'open-tabs'
    case 'worktree':
      return 'worktrees'
    case 'project-target':
      return 'projects'
    case 'settings':
    case 'quick-action':
      return 'middle'
    case 'task':
      return 'tasks'
    case 'section-header':
    case 'hint':
      return entry.section
    case 'create-worktree':
      return null
  }
}

export function describePaletteOccurrences(
  entries: readonly PaletteListEntry[],
  keys: readonly string[]
): PaletteObservedOccurrence[] {
  return entries.map((entry, index) => {
    const occurrence = {
      key: keys[index] ?? entry.id,
      id: entry.id,
      section: paletteEntrySection(entry)
    }
    return entry.type === 'section-header' || entry.type === 'hint'
      ? { ...occurrence, type: entry.type, section: entry.section, label: entry.label }
      : { ...occurrence, type: entry.type }
  })
}

export function observedPaletteSectionKeys(
  prefix: readonly PaletteObservedOccurrence[],
  section: PaletteSectionKey
): string[] {
  return prefix
    .filter(
      (entry) =>
        entry.section === section && entry.type !== 'section-header' && entry.type !== 'hint'
    )
    .map((entry) => entry.key)
}

function isDestination(entry: PaletteListEntry): entry is PaletteItem {
  return (
    entry.type !== 'hint' && entry.type !== 'section-header' && entry.type !== 'create-worktree'
  )
}

/** Reuses the committed prefix's structure, then lays out the newly ranked unseen suffix. */
export function reconcilePaletteObservedPrefix({
  prefix,
  entries,
  availableItems,
  onExpandSection
}: {
  prefix: readonly PaletteObservedOccurrence[]
  entries: readonly PaletteListEntry[]
  availableItems: readonly PaletteItem[]
  onExpandSection: (section: string) => void
}): PaletteListEntry[] {
  if (!prefix.length) {
    return [...entries]
  }
  const availableKeys = buildPaletteListEntryRenderKeys(availableItems.map((entry) => entry.id))
  const live = new Map(availableKeys.map((key, index) => [key, availableItems[index]]))
  const structural = new Map(entries.map((entry) => [entry.id, entry]))
  const prefixKeys = new Set<string>()
  const protectedControls = new Set<string>()
  const result: PaletteListEntry[] = []
  for (const occurrence of prefix) {
    if (occurrence.type === 'section-header' || occurrence.type === 'hint') {
      const current = structural.get(occurrence.id)
      if (current?.type === occurrence.type) {
        result.push(current)
      } else if (occurrence.type === 'section-header') {
        result.push({
          id: occurrence.id,
          type: 'section-header',
          section: occurrence.section,
          label: occurrence.label
        })
      } else {
        result.push({
          id: occurrence.id,
          type: 'hint',
          section: occurrence.section,
          label: occurrence.label,
          onSeeMore: () => onExpandSection(occurrence.section)
        })
      }
      protectedControls.add(occurrence.id)
    } else if (occurrence.type === 'create-worktree') {
      const current = structural.get(occurrence.id)
      if (current) {
        result.push(current)
        protectedControls.add(current.id)
      }
    } else {
      const current = live.get(occurrence.key)
      if (current) {
        result.push(current)
        prefixKeys.add(occurrence.key)
      }
    }
  }
  const keys = buildPaletteListEntryRenderKeys(entries.map((entry) => entry.id))
  const headers = new Map<PaletteSectionKey, SectionHeader>()
  for (const entry of entries) {
    if (entry.type === 'section-header') {
      headers.set(entry.section, entry)
    }
  }
  const last = result.at(-1)
  let lastSection = last ? paletteEntrySection(last) : null
  const usedIds = new Set(result.map((entry) => entry.id))
  let continuation = 0
  for (const [index, entry] of entries.entries()) {
    if (
      entry.type === 'section-header' ||
      protectedControls.has(entry.id) ||
      prefixKeys.has(keys[index])
    ) {
      continue
    }
    const section = paletteEntrySection(entry)
    if (section && section !== lastSection) {
      const header = headers.get(section)
      if (header) {
        let id = header.id
        while (usedIds.has(id)) {
          id = `${header.id}__observed_continued_${continuation++}`
        }
        result.push({ ...header, id })
        usedIds.add(id)
      }
      lastSection = section
    }
    result.push(entry)
  }
  const eligible = new Map<PaletteSectionKey, Set<string>>()
  for (const entry of availableItems) {
    const section = paletteEntrySection(entry)
    if (!section) {
      continue
    }
    const ids = eligible.get(section) ?? new Set<string>()
    ids.add(entry.id)
    eligible.set(section, ids)
  }
  const seen = new Map<PaletteSectionKey, Set<string>>()
  return result.flatMap((entry) => {
    const section = paletteEntrySection(entry)
    if (!section) {
      return [entry]
    }
    const ids = seen.get(section) ?? new Set<string>()
    if (isDestination(entry)) {
      ids.add(entry.id)
    }
    seen.set(section, ids)
    if (entry.type !== 'hint') {
      return [entry]
    }
    const count = Math.max(0, (eligible.get(section)?.size ?? 0) - ids.size)
    if (!count && !protectedControls.has(entry.id)) {
      return []
    }
    return [
      {
        ...entry,
        label: translate('worktreeJumpPalette.renderCapOverflow', '{{value0}} more', {
          value0: count
        })
      }
    ]
  })
}

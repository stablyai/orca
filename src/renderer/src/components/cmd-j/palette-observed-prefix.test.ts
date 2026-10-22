import { expect, it, vi } from 'vitest'
import { createPaletteSearchContext } from '@/lib/palette-match/palette-ranking'
import { buildWorkspaceTabBaseResult } from '@/lib/workspace-tab-palette-results'
import type { PaletteListEntry, WorkspaceTabPaletteItem } from '../worktree-jump-palette-model'
import { transcriptTab } from './palette-transcript-test-fixture'
import { capPaletteSection, reserveObservedPaletteSection } from './palette-section-render-cap'
import {
  describePaletteOccurrences,
  observedPaletteSectionKeys,
  reconcilePaletteObservedPrefix
} from './palette-observed-prefix'

const context = createPaletteSearchContext(1000)
const rows = (prefix: string, count: number): WorkspaceTabPaletteItem[] =>
  Array.from({ length: count }, (_, index) => {
    const result = buildWorkspaceTabBaseResult(transcriptTab(`${prefix}-${index}`), context)
    return { id: result.paletteIdentity, type: 'workspace-tab', result, transcriptReserved: true }
  })
const header: PaletteListEntry = {
  id: 'tabs-heading',
  type: 'section-header',
  section: 'open-tabs',
  label: 'Open Tabs'
}
const hint: PaletteListEntry = {
  id: 'tabs-overflow',
  type: 'hint',
  section: 'open-tabs',
  label: '20 more',
  onSeeMore: vi.fn()
}

it('protects a first viewport, lets 20 stronger arrivals replace an unseen full-cap suffix, and counts unique overflow', () => {
  const old = rows('ordinary', 50)
  const arrivals = rows('transcript', 20)
  const committed = [header, ...old]
  const prefix = describePaletteOccurrences(
    committed,
    committed.map((entry) => entry.id)
  ).slice(0, 6)
  const available = [
    ...arrivals,
    ...old.map((item) => ({ ...item, result: { ...item.result, secondaryText: 'live data' } }))
  ]
  const capped = capPaletteSection(
    reserveObservedPaletteSection(available, observedPaletteSectionKeys(prefix, 'open-tabs')),
    50
  )
  const entries = reconcilePaletteObservedPrefix({
    prefix,
    entries: [header, ...capped.visible, hint],
    availableItems: available,
    onExpandSection: vi.fn()
  })
  expect(entries.slice(0, 6).map((entry) => entry.id)).toEqual(
    committed.slice(0, 6).map((entry) => entry.id)
  )
  const visible = entries.filter(
    (entry): entry is WorkspaceTabPaletteItem => entry.type === 'workspace-tab'
  )
  expect(visible).toHaveLength(50)
  expect(arrivals.every((item) => visible.some((row) => row.id === item.id))).toBe(true)
  expect(visible[0].result.secondaryText).toBe('live data')
  expect(entries.at(-1)).toMatchObject({ type: 'hint', label: '20 more' })
  expect(capped.overflowCount).toBe(20)
})

it('preserves split headings and hint/control footprints despite a new leading section', () => {
  const old = rows('ordinary', 10)
  const arrivals = rows('transcript', 20)
  const committed = [
    header,
    ...old.slice(0, 2),
    hint,
    {
      id: '__header_projects_groups__',
      type: 'section-header' as const,
      section: 'projects' as const,
      label: 'Projects & Groups'
    }
  ]
  const prefix = describePaletteOccurrences(
    committed,
    committed.map((entry) => entry.id)
  )
  const next = reconcilePaletteObservedPrefix({
    prefix,
    entries: [header, ...arrivals, ...old, hint],
    availableItems: [...arrivals, ...old],
    onExpandSection: vi.fn()
  })
  expect(next.slice(0, committed.length).map((entry) => entry.id)).toEqual(
    committed.map((entry) => entry.id)
  )
  expect(next[3]).toMatchObject({ type: 'hint', label: '28 more' })
  expect(next[committed.length]).toMatchObject({ type: 'section-header', label: 'Open Tabs' })
  expect(new Set(next.map((entry) => entry.id)).size).toBe(next.length)
})

it('drops truly removed destinations, frees slots, and uses live rows for survivors', () => {
  const old = rows('ordinary', 3)
  const committed = [header, ...old]
  const prefix = describePaletteOccurrences(
    committed,
    committed.map((entry) => entry.id)
  )
  const available = [old[2], ...rows('new', 3)]
  const ordered = reserveObservedPaletteSection(
    available,
    observedPaletteSectionKeys(prefix, 'open-tabs')
  )
  const capped = capPaletteSection(ordered, 3)
  const next = reconcilePaletteObservedPrefix({
    prefix,
    entries: [header, ...capped.visible, hint],
    availableItems: available,
    onExpandSection: vi.fn()
  })
  expect(next.map((entry) => entry.id)).not.toContain(old[0].id)
  expect(next.map((entry) => entry.id)).not.toContain(old[1].id)
  expect(next.filter((entry) => entry.type === 'workspace-tab')).toHaveLength(3)
})

it('does not protect unobserved rows in subsequent batches', () => {
  const old = rows('ordinary', 50)
  const observed = [header, ...old.slice(0, 4)]
  const prefix = describePaletteOccurrences(
    observed,
    observed.map((entry) => entry.id)
  )
  for (const arrivals of [rows('first', 20), rows('second', 30)]) {
    const available = [...arrivals, ...old]
    const visible = capPaletteSection(
      reserveObservedPaletteSection(available, observedPaletteSectionKeys(prefix, 'open-tabs')),
      50
    ).visible
    expect(visible.slice(0, 4)).toEqual(old.slice(0, 4))
    expect(visible.slice(4, 4 + arrivals.length)).toEqual(arrivals)
  }
})

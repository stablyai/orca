// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import de from '@/i18n/locales/de.json'
import en from '@/i18n/locales/en.json'
import es from '@/i18n/locales/es.json'
import fr from '@/i18n/locales/fr.json'
import ja from '@/i18n/locales/ja.json'
import ko from '@/i18n/locales/ko.json'
import pt from '@/i18n/locales/pt.json'
import ru from '@/i18n/locales/ru.json'
import tr from '@/i18n/locales/tr.json'
import zh from '@/i18n/locales/zh.json'
import zhHant from '@/i18n/locales/zh-Hant.json'
import type { BundledSkillLocation } from '../../../../../shared/skills/bundled/bundled-skill-locations'
import type { BundledSkillPlanSkillSummary } from '../../../../../shared/skills/bundled/bundled-skill-summary'
import { SkillUpdateRow } from './SkillUpdateRow'

afterEach(cleanup)

const REPLACE_LABEL = "Replace with this version's copy (keeps a backup)"

function catalogLabel(catalog: object): string {
  const value = [
    'auto',
    'components',
    'skills',
    'SkillUpdateRow',
    'replaceWithOrca'
  ].reduce<unknown>(
    (node, key) =>
      node && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined,
    catalog
  )
  if (typeof value !== 'string') {
    throw new Error('replaceWithOrca missing')
  }
  return value
}

function skill(
  location: Pick<BundledSkillLocation, 'reason' | 'replaceable'>
): BundledSkillPlanSkillSummary {
  return {
    name: 'demo-skill',
    state: 'current',
    upToDate: false,
    locations: [
      {
        path: '/skills/demo-skill',
        displayPath: '~/.agents/skills/demo-skill',
        place: { kind: 'agents', names: ['Codex'] },
        state: 'leave',
        reason: location.reason,
        replaceable: location.replaceable
      }
    ]
  }
}

function renderRow(location: Pick<BundledSkillLocation, 'reason' | 'replaceable'>): void {
  render(
    <SkillUpdateRow
      skill={skill(location)}
      phase="plan"
      showLocations={false}
      replace={{ isReplaced: () => false, onReplaceChange: () => undefined }}
    />
  )
}

describe('SkillUpdateRow replace label', () => {
  it("names an unrecognized copy as this version's text, not a newer Orca copy", () => {
    renderRow({ reason: null, replaceable: true })
    const box = screen.getByRole('checkbox')
    expect(box).toHaveAccessibleName(REPLACE_LABEL)
    expect(box).not.toHaveAccessibleName(/newer|up to date|Orca's copy/i)
  })

  it('keeps replace hidden when another build wrote the copy', () => {
    renderRow({ reason: 'other-build', replaceable: false })
    expect(screen.queryByRole('checkbox')).toBeNull()
  })

  it("keeps the English catalog on this version's copy and drops Orca from every catalog", () => {
    expect(catalogLabel(en)).toBe(REPLACE_LABEL)
    for (const catalog of [de, en, es, fr, ja, ko, pt, ru, tr, zh, zhHant]) {
      const label = catalogLabel(catalog)
      expect(label).not.toMatch(/Orca/)
      expect(label.trim().length).toBeGreaterThan(0)
    }
  })
})

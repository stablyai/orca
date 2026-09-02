/**
 * Status pills in Settings and Stats used to be built from bare string literals
 * inside local helper functions, so they stayed English no matter which language
 * was selected. The coverage audit does not reach them: it inspects JSX
 * attributes and object properties, not values returned by helpers.
 *
 * These assertions pin the catalog contract for those helpers. A future refactor
 * that drops `translate()` and returns a literal again would leave the key
 * missing from `en.json` and fail here.
 */
import { describe, expect, it } from 'vitest'
import en from './locales/en.json'
import es from './locales/es.json'
import ja from './locales/ja.json'
import ko from './locales/ko.json'
import zh from './locales/zh.json'

const LOCALE_CATALOGS = { es, ja, ko, zh }

function lookupIn(catalog: unknown, key: string): string | undefined {
  const value = key
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
      catalog
    )
  return typeof value === 'string' ? value : undefined
}

function lookup(key: string): string | undefined {
  return lookupIn(en, key)
}

function placeholdersOf(value: string): string[] {
  return [...new Set(value.match(/\{\{[^}]+\}\}/g) ?? [])].sort()
}

const REQUIRED_KEYS: Record<string, string> = {
  // DeveloperPermissionsPane — macOS permission rows
  'auto.components.settings.DeveloperPermissionsPane.statusGranted': 'Granted',
  'auto.components.settings.DeveloperPermissionsPane.statusDenied': 'Denied',
  'auto.components.settings.DeveloperPermissionsPane.statusNotRequested': 'Not requested',
  'auto.components.settings.DeveloperPermissionsPane.statusRestricted': 'Restricted',
  'auto.components.settings.DeveloperPermissionsPane.statusUnsupported': 'macOS only',
  'auto.components.settings.DeveloperPermissionsPane.statusEntitled': 'Entitled',
  'auto.components.settings.DeveloperPermissionsPane.statusCheckManually': 'Check manually',
  'auto.components.settings.DeveloperPermissionsPane.actionRequest': 'Request',
  'auto.components.settings.DeveloperPermissionsPane.actionTriggerPrompt': 'Trigger Prompt',
  'auto.components.settings.DeveloperPermissionsPane.actionOpenSettings': 'Open Settings',
  // ComputerUsePane — permission rows
  'auto.components.settings.ComputerUsePane.statusGranted': 'Granted',
  'auto.components.settings.ComputerUsePane.statusUnsupported': 'macOS only',
  'auto.components.settings.ComputerUsePane.statusNotEnabled': 'Not enabled',
  // Source-control CLI integration cards
  'auto.components.settings.cli.source.control.integration.cards.statusConnected': 'Connected',
  'auto.components.settings.cli.source.control.integration.cards.statusUnavailable': 'Unavailable',
  'auto.components.settings.cli.source.control.integration.cards.statusNotInstalled':
    'Not installed',
  'auto.components.settings.cli.source.control.integration.cards.statusNotAuthenticated':
    'Not authenticated',
  // Stats — provider rows
  'auto.components.stats.usage.overview.sections.statusScanning': 'Scanning',
  'auto.components.stats.usage.overview.sections.statusEnabled': 'Enabled',
  'auto.components.stats.usage.overview.sections.statusOff': 'Off'
}

const INTERPOLATED_KEYS: Record<string, string[]> = {
  'auto.components.stats.StatsPane.trackingSince': ['{{value0}}'],
  'auto.components.settings.computerUseSummary.permissionsRequired_one': [],
  'auto.components.settings.computerUseSummary.permissionsRequired_other': ['{{value0}}'],
  'auto.components.settings.computerUseSummary.unavailableDescription': ['{{value0}}'],
  'auto.components.settings.OrchestrationSkillAgentCoverage.fullCoverage_one': [],
  'auto.components.settings.OrchestrationSkillAgentCoverage.fullCoverage_other': ['{{value0}}'],
  'auto.components.settings.OrchestrationSkillAgentCoverage.partialCoverage': [
    '{{value0}}',
    '{{value1}}'
  ]
}

// Base keys i18next resolves through CLDR plural categories (`<key>_<suffix>`).
const PLURAL_KEYS = [
  'auto.components.settings.computerUseSummary.permissionsRequired',
  'auto.components.settings.OrchestrationSkillAgentCoverage.fullCoverage'
]

function pluralCategories(locale: string): string[] {
  return [...new Intl.PluralRules(locale).resolvedOptions().pluralCategories]
}

// A locale owes `_other` plus whichever of its categories English also spells
// out. Categories English never defines (es `many`, only reached past 1e6) fall
// back to the English source instead of rendering wrong, so they aren't gated.
function requiredPluralSuffixes(locale: string, base: string): string[] {
  return pluralCategories(locale).filter(
    (category) => category === 'other' || lookup(`${base}_${category}`) !== undefined
  )
}

describe('settings and stats status labels', () => {
  it.each(Object.entries(REQUIRED_KEYS))('keeps %s in the English catalog', (key, expected) => {
    expect(lookup(key)).toBe(expected)
  })

  it.each(Object.entries(INTERPOLATED_KEYS))(
    'keeps the placeholders of %s intact',
    (key, placeholders) => {
      const value = lookup(key)
      expect(value).toBeDefined()
      for (const placeholder of placeholders) {
        expect(value).toContain(placeholder)
      }
    }
  )

  it('keeps the orchestration usage summaries in the catalog', () => {
    for (const id of [
      'handoffSummary',
      'worktreeHandoffSummary',
      'childSequenceSummary',
      'childParallelSummary',
      'prSplitSummary'
    ]) {
      expect(lookup(`auto.lib.orchestration.usage.examples.${id}`)).toBeTruthy()
    }
  })
})

// Translation lands incrementally and a missing key renders the English
// `translate()` fallback, so absence is fine — a *present* value that drops a
// placeholder or invents one interpolates to nothing at runtime, and a plural
// family translated only halfway silently reverts to English for some counts.
describe('shipped locale catalogs', () => {
  it.each(Object.entries(LOCALE_CATALOGS))(
    '%s keeps the English placeholders of every message it translates',
    (_locale, catalog) => {
      for (const key of Object.keys(INTERPOLATED_KEYS)) {
        const localized = lookupIn(catalog, key)
        if (localized === undefined) {
          continue
        }
        const english = lookup(key)
        expect(english, `${key} missing from en.json`).toBeDefined()
        expect(placeholdersOf(localized), `${key} placeholders drifted`).toEqual(
          placeholdersOf(english ?? '')
        )
      }
    }
  )

  it.each(Object.entries(LOCALE_CATALOGS))(
    '%s completes every plural family it translates',
    (locale, catalog) => {
      for (const base of PLURAL_KEYS) {
        const suffixes = [...new Set([...pluralCategories(locale), ...pluralCategories('en')])]
        if (!suffixes.some((suffix) => lookupIn(catalog, `${base}_${suffix}`))) {
          continue
        }
        for (const suffix of requiredPluralSuffixes(locale, base)) {
          expect(lookupIn(catalog, `${base}_${suffix}`), `${base}_${suffix} missing`).toBeTruthy()
        }
      }
    }
  )
})

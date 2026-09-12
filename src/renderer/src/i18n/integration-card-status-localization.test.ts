/**
 * Integration cards build their status pill inside the JSX call, which the
 * coverage audit does not inspect — it looks at JSX attributes and object
 * properties, not conditional expressions passed to a prop. These assertions
 * pin the catalog contract so a card that goes back to a bare literal fails here.
 */
import { describe, expect, it } from 'vitest'
import en from './locales/en.json'

function lookup(key: string): string | undefined {
  const value = key
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
      en as unknown
    )
  return typeof value === 'string' ? value : undefined
}

const REQUIRED_KEYS: Record<string, string> = {
  // Linear and other task trackers
  'auto.components.settings.task.tracker.integration.cards.statusConnected': 'Connected',
  'auto.components.settings.task.tracker.integration.cards.statusNotConnected': 'Not connected',
  // Jira
  'auto.components.settings.jira.integration.card.statusConnected': 'Connected',
  'auto.components.settings.jira.integration.card.statusNotConnected': 'Not connected',
  // Bitbucket, Azure DevOps, Gitea
  'auto.components.settings.token.source.control.integration.cards.statusConnected': 'Connected',
  'auto.components.settings.token.source.control.integration.cards.statusConfigured': 'Configured',
  'auto.components.settings.token.source.control.integration.cards.statusUnavailable':
    'Unavailable',
  'auto.components.settings.token.source.control.integration.cards.statusNotConfigured':
    'Not configured',
  'auto.components.settings.token.source.control.integration.cards.statusOptionalSetup':
    'Optional setup',
  'auto.components.settings.token.source.control.integration.cards.statusAuthFailed': 'Auth failed'
}

describe('integration card status labels', () => {
  it.each(Object.entries(REQUIRED_KEYS))('keeps %s in the English catalog', (key, expected) => {
    expect(lookup(key)).toBe(expected)
  })
})

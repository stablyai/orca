import { describe, expect, it, vi } from 'vitest'
import en from '@/i18n/locales/en.json'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('@/i18n/localized-catalog', () => ({
  createLocalizedCatalog:
    <T>(loader: () => T) =>
    () =>
      loader()
}))

vi.mock('./settings-search-keywords', () => ({
  translateSearchKeyword: (_key: string, fallback: string) => [fallback]
}))

import { getStatusBarToggles } from './appearance-status-bar-search'

describe('getStatusBarToggles', () => {
  it('keeps the real English catalog description aligned with the status-bar entry', () => {
    expect(en.auto.components.settings.appearance.search.zaiDescription).toBe(
      'Show Z.ai GLM usage in the status bar.'
    )
  })

  it('includes Antigravity usage so Appearance can toggle the default-on status item', () => {
    const antigravityToggle = getStatusBarToggles().find((entry) => entry.id === 'antigravity')

    expect(antigravityToggle).toMatchObject({
      title: 'Antigravity Usage',
      description: 'Show Antigravity subscription usage in the status bar.',
      toggleDescription: 'Show Antigravity subscription usage for the active workspace.'
    })
    expect(antigravityToggle?.keywords).toEqual(
      expect.arrayContaining(['status bar', 'antigravity', 'usage', 'subscription', 'google'])
    )
  })

  it('includes Z.ai GLM usage for status-bar search and toggling', () => {
    const zaiToggle = getStatusBarToggles().find((entry) => entry.id === 'zai')
    expect(zaiToggle).toMatchObject({
      title: 'Z.ai GLM Usage',
      description: 'Show Z.ai GLM usage in the status bar.',
      toggleDescription: 'Show Z.ai GLM usage for the active workspace.'
    })
    expect(zaiToggle?.keywords).toEqual(
      expect.arrayContaining(['status bar', 'z.ai', 'glm', 'api key'])
    )
  })

  it('includes MiniMax usage so Appearance can toggle the default-on status item', () => {
    const miniMaxToggle = getStatusBarToggles().find((entry) => entry.id === 'minimax')

    expect(miniMaxToggle).toMatchObject({
      title: 'MiniMax Usage',
      description: 'Show MiniMax subscription usage in the status bar.',
      toggleDescription: 'Show MiniMax subscription usage for the active workspace.'
    })
    expect(miniMaxToggle?.keywords).toEqual(
      expect.arrayContaining(['status bar', 'minimax', 'usage', 'subscription', 'cookie'])
    )
  })
})

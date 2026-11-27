import { describe, expect, it } from 'vitest'
import { getGitHubTaskKind, normalizeGitHubTaskPreset } from './task-github-search'
import { getTaskPresetQuery } from './task-preset-query'

describe('GitHub Tasks landing tab', () => {
  it('lands on PRs when no tab choice was saved', () => {
    for (const unsaved of [undefined, null, 'all'] as const) {
      const preset = normalizeGitHubTaskPreset(unsaved)
      expect(preset).toBe('prs')
      expect(getGitHubTaskKind(preset, getTaskPresetQuery(preset))).toBe('prs')
      // Prefetch keys off the raw setting; it must match the query the page mounts with.
      expect(getTaskPresetQuery(unsaved ?? null)).toBe(getTaskPresetQuery(preset))
    }
  })

  it('keeps a saved Issues choice', () => {
    for (const saved of ['issues', 'my-issues'] as const) {
      const preset = normalizeGitHubTaskPreset(saved)
      expect(preset).toBe(saved)
      expect(getGitHubTaskKind(preset, getTaskPresetQuery(preset))).toBe('issues')
    }
  })
})

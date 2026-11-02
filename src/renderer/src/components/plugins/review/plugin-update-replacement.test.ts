import { describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/i18n', () => ({
  getIntlLocale: () => 'en',
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_, name: string) => values?.[name] ?? '')
}))

import type { PluginMarketplaceHostInstallPreview } from '../../../../../preload/api-types'
import { updateChanges } from './PluginUpdateCandidate'

function preview(contributions: string[]): PluginMarketplaceHostInstallPreview {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: updateChanges reads only accessGrowth and the manifest's commands.
  return {
    accessGrowth: { capabilities: [], execution: null, contributions },
    manifest: {
      contributes: {
        commands: [
          { id: 'board', title: 'Open task board', replaces: 'view.tasks' },
          { id: 'other', title: 'Other' }
        ]
      }
    }
  } as unknown as PluginMarketplaceHostInstallPreview
}

describe('an update that adds a replacing command', () => {
  it('names the action it takes over, not only "Commands"', () => {
    expect(updateChanges(preview(['commands'])).warnings).toEqual([
      'Commands',
      expect.stringMatching(/^Open task board runs instead of Orca’s /)
    ])
    expect(updateChanges(preview([])).warnings).toEqual([])
  })
})

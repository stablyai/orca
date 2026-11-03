import { describe, expect, it } from 'vitest'
import { buildImportedHookSettings, getDetectedSetupPreviewContent } from './setup-script-prompt'
import { SETUP_SCRIPT_IMPORT_PROVIDERS } from '../../../shared/setup-script-import-providers'
import type { Repo } from '../../../shared/repo-types'

const repo: Repo = {
  id: 'repo',
  path: '/repo',
  displayName: 'Repo',
  badgeColor: '#000',
  addedAt: 1
}

describe('getDetectedSetupPreviewContent', () => {
  it.each(SETUP_SCRIPT_IMPORT_PROVIDERS)(
    'previews exactly what saving a %s candidate writes',
    (provider) => {
      const candidate = {
        provider,
        label: provider,
        files: ['config'],
        setup: `${provider} setup`,
        archive: `${provider} archive`
      }
      const preview = getDetectedSetupPreviewContent(candidate, 'edited setup')
      const saved = buildImportedHookSettings(
        repo,
        preview.editable ? { ...candidate, setup: preview.setup } : candidate,
        false
      )

      expect(preview.editable).toBe(provider === 'package-manager')
      expect(preview.setup).toBe(saved.scripts.setup)
      expect(preview.archive).toBe(saved.scripts.archive)
    }
  )
})

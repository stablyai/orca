import { describe, expect, it } from 'vitest'
import {
  buildImportedHookSettings,
  getDetectedSetupPreviewContent,
  getSetupScriptFirstLine,
  isSetupScriptPromptActionable
} from './setup-script-prompt'
import { SETUP_SCRIPT_IMPORT_PROVIDERS } from '../../../shared/workspace-setup/setup-script-import-providers'
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

describe('getSetupScriptFirstLine', () => {
  it('summarizes a multi-line script by its first command', () => {
    expect(getSetupScriptFirstLine('\n  pnpm install  \n\npnpm build\n')).toEqual({
      firstLine: 'pnpm install',
      hasMore: true
    })
    expect(getSetupScriptFirstLine('bun install\n')).toEqual({
      firstLine: 'bun install',
      hasMore: false
    })
  })
})

describe('isSetupScriptPromptActionable', () => {
  const okWithoutSetup = {
    status: 'ok' as const,
    repoId: 'repo',
    hasEffectiveSetup: false,
    hasSharedHooks: false,
    candidate: null
  }

  it('stays hidden when nothing was detected and there is nothing to warn about', () => {
    expect(isSetupScriptPromptActionable(okWithoutSetup, repo)).toBe(false)
  })

  it('shows the warning when local-only policy ignores shared setup scripts', () => {
    const localOnlyRepo = {
      hookSettings: {
        mode: 'auto' as const,
        commandSourcePolicy: 'local-only' as const,
        scripts: { setup: '', archive: '' }
      }
    }
    expect(isSetupScriptPromptActionable(okWithoutSetup, localOnlyRepo)).toBe(true)
  })

  it('shows a detected package-manager candidate', () => {
    const candidate = {
      provider: 'package-manager' as const,
      label: 'package manager',
      files: ['package.json', 'pnpm-lock.yaml'],
      setup: 'pnpm install'
    }
    expect(isSetupScriptPromptActionable({ ...okWithoutSetup, candidate }, repo)).toBe(true)
  })
})

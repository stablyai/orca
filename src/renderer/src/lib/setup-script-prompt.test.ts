import { describe, expect, it, vi } from 'vitest'
import type { SetupScriptImportCandidate } from '../../../shared/setup-script-imports'
import type { Repo } from '../../../shared/types'
import {
  buildImportedHookSettings,
  filterSetupScriptPromptDismissalsToValidRepos,
  formatCandidateProvenance,
  getSetupScriptPromptDismissalKey,
  ignoresSharedSetupScripts,
  inspectSetupScriptPromptState,
  isSetupScriptPromptDismissed
} from './setup-script-prompt'

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/repo',
    displayName: 'Repo',
    badgeColor: '#000',
    addedAt: 0,
    ...overrides
  }
}

describe('setup script prompt inspection', () => {
  it('returns ok with an import candidate when no setup script is effective', async () => {
    const candidate: SetupScriptImportCandidate = {
      provider: 'codex',
      label: 'Codex',
      files: ['.codex/environments/environment.toml'],
      setup: 'pnpm install'
    }

    await expect(
      inspectSetupScriptPromptState({
        repo: makeRepo(),
        checkHooks: vi.fn().mockResolvedValue({
          hasHooks: false,
          hooks: null,
          mayNeedUpdate: false
        }),
        inspectImports: vi.fn().mockResolvedValue([candidate])
      })
    ).resolves.toEqual({
      status: 'ok',
      repoId: 'repo-1',
      hasEffectiveSetup: false,
      hasSharedHooks: false,
      candidate
    })
  })

  it('does not inspect imports when an effective setup script exists', async () => {
    const inspectImports = vi.fn()

    await expect(
      inspectSetupScriptPromptState({
        repo: makeRepo(),
        checkHooks: vi.fn().mockResolvedValue({
          hasHooks: true,
          hooks: { scripts: { setup: 'pnpm install' } },
          mayNeedUpdate: false
        }),
        inspectImports
      })
    ).resolves.toMatchObject({
      status: 'ok',
      repoId: 'repo-1',
      hasEffectiveSetup: true,
      hasSharedHooks: true,
      candidate: null
    })
    expect(inspectImports).not.toHaveBeenCalled()
  })

  it('returns error status instead of inferring setup absence when inspection fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(
      inspectSetupScriptPromptState({
        repo: makeRepo(),
        checkHooks: vi.fn().mockRejectedValue(new Error('ssh disconnected')),
        inspectImports: vi.fn()
      })
    ).resolves.toEqual({ status: 'error', repoId: 'repo-1' })

    warn.mockRestore()
  })

  it('returns error status when hook inspection reports an SSH read failure', async () => {
    await expect(
      inspectSetupScriptPromptState({
        repo: makeRepo({ connectionId: 'ssh-1' }),
        checkHooks: vi.fn().mockResolvedValue({
          status: 'error',
          hasHooks: false,
          hooks: null,
          mayNeedUpdate: false
        }),
        inspectImports: vi.fn()
      })
    ).resolves.toEqual({ status: 'error', repoId: 'repo-1' })
  })

  it('preserves import behavior for repos with shared hooks', () => {
    const settings = buildImportedHookSettings(
      makeRepo({ hookSettings: { scripts: { archive: 'cleanup' } } as Repo['hookSettings'] }),
      {
        provider: 'conductor',
        label: 'Conductor',
        files: ['conductor.json'],
        setup: 'npm install'
      },
      true
    )

    expect(settings.commandSourcePolicy).toBe('run-both')
    expect(settings.scripts.setup).toBe('npm install')
    expect(settings.scripts.archive).toBe('cleanup')
  })

  it('keeps explicit local-only policy when importing a local setup command', () => {
    const settings = buildImportedHookSettings(
      makeRepo({
        hookSettings: {
          commandSourcePolicy: 'local-only',
          scripts: {}
        } as Repo['hookSettings']
      }),
      {
        provider: 'codex',
        label: 'Codex',
        files: ['.codex/environments/environment.toml'],
        setup: 'pnpm install'
      },
      true
    )

    expect(settings.commandSourcePolicy).toBe('local-only')
    expect(settings.scripts.setup).toBe('pnpm install')
  })

  it('detects when shared orca.yaml setup scripts are ignored by local-only settings', () => {
    expect(
      ignoresSharedSetupScripts(
        makeRepo({
          hookSettings: {
            commandSourcePolicy: 'local-only',
            scripts: {}
          } as Repo['hookSettings']
        })
      )
    ).toBe(true)
  })

  it('ignores legacy prompt dismissals and honors the generation prompt version', () => {
    expect(isSetupScriptPromptDismissed('repo-1', ['repo-1'])).toBe(false)
    expect(
      isSetupScriptPromptDismissed('repo-1', [getSetupScriptPromptDismissalKey('repo-1')])
    ).toBe(true)
  })

  it('keeps only current-version prompt dismissals for valid repos', () => {
    expect(
      filterSetupScriptPromptDismissalsToValidRepos(
        [
          'repo-1',
          getSetupScriptPromptDismissalKey('repo-1'),
          getSetupScriptPromptDismissalKey('repo-1'),
          getSetupScriptPromptDismissalKey('repo-2')
        ],
        new Set(['repo-1'])
      )
    ).toEqual([getSetupScriptPromptDismissalKey('repo-1')])
  })

  it('formats setup candidate provenance for sidebar review copy', () => {
    expect(
      formatCandidateProvenance({
        provider: 'package-manager',
        label: 'package manager',
        files: ['pnpm-lock.yaml', 'package.json'],
        setup: 'pnpm install'
      })
    ).toBe('pnpm-lock.yaml')
    expect(
      formatCandidateProvenance({
        provider: 'codex',
        label: 'Codex environment',
        files: ['.codex/environments/environment.toml', 'package.json'],
        setup: 'pnpm install'
      })
    ).toBe('.codex/environments/environment.toml and package.json')
  })
})

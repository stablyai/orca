import { describe, expect, it } from 'vitest'
import { translate } from '@/i18n/i18n'
import { sampleBuild } from './cloud-environment-fixture-data'
import { environmentFailureFix } from './environment-failure-fix'

// The real translator: with no catalog loaded in tests it returns each default.
const t = translate
const environment = { installScript: 'pnpm install' }
const failed = (failedStep: 'install' | 'clone' | 'boot') =>
  sampleBuild({ status: 'failed', failedStep, error: `${failedStep}_failed` })

describe('environmentFailureFix', () => {
  it('offers an agent for install-script failures', () => {
    const fix = environmentFailureFix({
      build: failed('install'),
      logLines: null,
      environment,
      repoId: null,
      t
    })
    expect(fix.onFixWithAgent).not.toBeNull()
    expect(fix.onGiveAccess).toBeNull()
  })

  it('tells clone failures apart from the visible log, and offers nothing without it', () => {
    const content = environmentFailureFix({
      build: failed('clone'),
      logLines: ['Cloning https://github.com/acme/web (main)', 'submodule path failed'],
      environment,
      repoId: null,
      t
    })
    expect(content.onFixWithAgent).not.toBeNull()
    const access = environmentFailureFix({
      build: failed('clone'),
      logLines: ['Cloning https://github.com/acme/web', 'remote: Repository not found.'],
      environment,
      repoId: null,
      t
    })
    expect(access.onFixWithAgent).toBeNull()
    expect(access.onGiveAccess).not.toBeNull()
    const unseen = environmentFailureFix({
      build: failed('clone'),
      logLines: null,
      environment,
      repoId: null,
      t
    })
    expect(unseen).toEqual({ onFixWithAgent: null, onGiveAccess: null })
  })

  it('offers nothing for other steps or builds that did not fail', () => {
    for (const build of [failed('boot'), sampleBuild()]) {
      expect(environmentFailureFix({ build, logLines: [], environment, repoId: null, t })).toEqual({
        onFixWithAgent: null,
        onGiveAccess: null
      })
    }
  })
})

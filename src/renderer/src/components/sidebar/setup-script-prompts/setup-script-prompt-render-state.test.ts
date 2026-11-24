import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import { TEST_REPO } from '../../store/repos/repo.test-fixture'
import {
  isSetupScriptPromptActionable,
  type SetupScriptPromptState
} from './setup-script-prompt-render-state'

const nothingDetected: SetupScriptPromptState = {
  status: 'ok',
  repoId: 'repo1',
  repoHostIdentity: 'repo1',
  hasEffectiveSetup: false,
  hasSharedHooks: false,
  candidate: null
}

const localOnlyRepo: Repo = {
  ...TEST_REPO,
  hookSettings: {
    mode: 'auto',
    commandSourcePolicy: 'local-only',
    scripts: { setup: '', archive: '' }
  }
}

describe('isSetupScriptPromptActionable', () => {
  it('hides the card only when there is nothing to suggest, warn about, or retry', () => {
    expect(isSetupScriptPromptActionable(nothingDetected, TEST_REPO)).toBe(false)
    expect(isSetupScriptPromptActionable(nothingDetected, localOnlyRepo)).toBe(true)
    expect(
      isSetupScriptPromptActionable(
        {
          ...nothingDetected,
          candidate: {
            provider: 'package-manager',
            label: 'pnpm',
            files: ['pnpm-lock.yaml'],
            setup: 'pnpm install'
          }
        },
        TEST_REPO
      )
    ).toBe(true)
    expect(
      isSetupScriptPromptActionable(
        { status: 'error', repoId: 'repo1', repoHostIdentity: 'repo1' },
        TEST_REPO
      )
    ).toBe(true)
  })
})

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ONBOARDING_FLOW_PATH = join(import.meta.dirname, 'use-onboarding-flow.ts')

describe('useOnboardingFlow project-added handoff', () => {
  it('routes Git repo completion through the shared default-checkout opener', () => {
    const source = readFileSync(ONBOARDING_FLOW_PATH, 'utf8')

    expect(source).toContain('openProjectDefaultCheckout({')
    expect(source).toContain('repoId: projectId')
    expect(source).toContain(
      "source: path === 'clone_url' ? 'onboarding_clone_url' : 'onboarding_open_folder'"
    )
    expect(source).toContain('setHideDefaultBranchWorkspace')
    expect(source).not.toContain("openModal('project-added'")
  })
})

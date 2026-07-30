import { describe, expect, it } from 'vitest'
import { computerUseHelperGuidance } from './computer-use-helper-guidance'

describe('computerUseHelperGuidance', () => {
  it('gives source-build guidance in development', () => {
    expect(computerUseHelperGuidance('the helper was not found', true)).toContain(
      'Run pnpm build:computer-macos and restart Orca from this worktree.'
    )
  })

  it('gives installation guidance in packaged builds', () => {
    expect(computerUseHelperGuidance('the helper was not found', false)).toContain(
      'Update or reinstall Orca'
    )
  })
})

import { describe, expect, it } from 'vitest'
import { runGitFixture } from './git-process-test-fixture'

describe('runGitFixture', () => {
  it('returns stdout when Git succeeds', async () => {
    const stdout = await runGitFixture(process.cwd(), ['--version'])

    expect(stdout).toMatch(/^git version /)
  })

  it('throws when Git exits unsuccessfully', async () => {
    const failure = runGitFixture(process.cwd(), ['--definitely-invalid-option'])

    await expect(failure).rejects.toThrow(/git --definitely-invalid-option/)
  })
})

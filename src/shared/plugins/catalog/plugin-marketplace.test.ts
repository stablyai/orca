import { describe, expect, it } from 'vitest'
import { isSameGitRepository } from './plugin-marketplace'

describe('isSameGitRepository', () => {
  it('matches respellings and treats a GitLab subgroup move as a different repository', () => {
    expect(
      isSameGitRepository(
        'https://gitlab.com/acme/team-a/tool.git',
        'git@gitlab.com:Acme/Team-A/Tool'
      )
    ).toBe(true)
    // A self-hosted server may serve these as two repositories, so an approval must not carry.
    expect(
      isSameGitRepository(
        'https://git.example.com/team/Plugin.git',
        'https://git.example.com/team/plugin.git'
      )
    ).toBe(false)
    expect(
      isSameGitRepository(
        'https://gitlab.com/acme/team-a/tool',
        'https://gitlab.com/acme/evil/tool'
      )
    ).toBe(false)
  })
})

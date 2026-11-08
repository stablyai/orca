import { describe, expect, it } from 'vitest'
import { getProvisionedRootRecipeRepoUrl } from './ephemeral-vm-recipe-repo-url'

describe('getProvisionedRootRecipeRepoUrl', () => {
  it('does not expose the repository URL to ordinary recipes', () => {
    expect(
      getProvisionedRootRecipeRepoUrl(
        undefined,
        'https://recipe-user:recipe-token@git.example.com/team/repo.git'
      )
    ).toBeUndefined()
  })

  it('removes credentials before exposing the URL to a provisioned-root recipe', () => {
    expect(
      getProvisionedRootRecipeRepoUrl(
        'provisioned-root',
        'https://recipe-user:recipe-token@git.example.com/team/repo.git'
      )
    ).toBe('https://git.example.com/team/repo.git')
  })
})

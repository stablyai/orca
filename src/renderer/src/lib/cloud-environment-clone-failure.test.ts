import { describe, expect, it } from 'vitest'
import { classifyCloneFailure, cloneFailureRepoName } from './cloud-environment-clone-failure'

describe('classifyCloneFailure', () => {
  it('hands repo-content failures (submodules, LFS, bad paths) to an agent', () => {
    for (const error of [
      "fatal: clone of 'git@github.com:acme/vendor.git' into submodule path 'vendor' failed",
      'Error downloading object: assets/model.bin: Smudge error: git-lfs filter-process',
      "error: invalid path 'docs/aux.md'",
      'warning: Clone succeeded, but checkout failed.'
    ]) {
      expect(classifyCloneFailure(['Cloning https://github.com/acme/web (main)', error]).kind).toBe(
        'content'
      )
    }
  })

  it('sends access and auth failures to GitHub, never to an agent', () => {
    for (const error of [
      'remote: Repository not found.',
      "fatal: Authentication failed for 'https://github.com/acme/web/'",
      "fatal: unable to access 'https://github.com/acme/web/': The requested URL returned error: 403",
      'fatal: could not read Username for https://github.com: terminal prompts disabled'
    ]) {
      expect(classifyCloneFailure(['Cloning https://github.com/acme/web', error]).kind).toBe(
        'access'
      )
    }
    // Access wins when both show up.
    expect(
      classifyCloneFailure(['submodule update', 'The requested URL returned error: 403']).kind
    ).toBe('access')
  })

  it('offers nothing for what it does not recognize, such as a missing branch', () => {
    expect(
      classifyCloneFailure([
        'Cloning https://github.com/acme/web (release)',
        'warning: Could not find remote branch release to clone.'
      ]).kind
    ).toBe('unknown')
  })

  it('names the repo that failed: the last one cloned, or the one Orca names', () => {
    const failure = classifyCloneFailure([
      'Cloning https://github.com/acme/web (main)',
      '  at 9f2c1ab init',
      'Cloning https://github.com/acme/api.git',
      'error: invalid path',
      '::orca-error:: Could not clone https://github.com/acme/api at main. Check that the branch exists.'
    ])
    expect(failure.repoUrl).toBe('https://github.com/acme/api')
    expect(cloneFailureRepoName(failure.repoUrl)).toBe('acme/api')
    expect(cloneFailureRepoName(null)).toBeNull()
  })
})

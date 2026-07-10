import { describe, expect, it } from 'vitest'
import { canUseGitLabSmartSource } from './SmartWorkspaceNameField'

describe('SmartWorkspaceNameField provider boundaries', () => {
  it('advertises local GitLab smart lookup only when local glab is available', () => {
    expect(
      canUseGitLabSmartSource({
        localGitlabAvailable: true,
        repoBackedSourcesDisabled: false,
        sourceHostId: 'local'
      })
    ).toBe(true)
    expect(
      canUseGitLabSmartSource({
        localGitlabAvailable: true,
        repoBackedSourcesDisabled: true,
        sourceHostId: 'local'
      })
    ).toBe(false)
    expect(
      canUseGitLabSmartSource({
        localGitlabAvailable: false,
        repoBackedSourcesDisabled: false,
        sourceHostId: 'local'
      })
    ).toBe(false)
  })

  it('does not hide SSH or runtime GitLab sources based on local glab preflight', () => {
    expect(
      canUseGitLabSmartSource({
        localGitlabAvailable: false,
        repoBackedSourcesDisabled: false,
        sourceHostId: 'ssh:builder'
      })
    ).toBe(true)
    expect(
      canUseGitLabSmartSource({
        localGitlabAvailable: false,
        repoBackedSourcesDisabled: false,
        sourceHostId: 'runtime:env-1'
      })
    ).toBe(true)
  })
})

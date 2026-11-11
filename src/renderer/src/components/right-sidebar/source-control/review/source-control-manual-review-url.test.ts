import { describe, expect, it } from 'vitest'
import { buildSourceControlManualReviewUrl } from './manual-review-url'

describe('buildSourceControlManualReviewUrl', () => {
  it('qualifies GitHub fork heads when the push target remote differs from the base repo', () => {
    expect(
      buildSourceControlManualReviewUrl({
        baseRef: 'refs/remotes/upstream/main',
        branchName: 'feature/fork-head',
        repoRemoteName: 'upstream',
        repoRemoteUrl: 'https://github.com/stablyai/orca.git',
        pushTarget: {
          remoteName: 'fork',
          branchName: 'feature/fork-head',
          remoteUrl: 'git@github.com:contributor/orca.git'
        }
      })
    ).toBe('https://github.com/stablyai/orca/compare/main...contributor:feature/fork-head?expand=1')
  })

  it('keeps slashes literal in a GitHub compare URL for a slash-containing branch name', () => {
    expect(
      buildSourceControlManualReviewUrl({
        baseRef: 'refs/remotes/origin/main',
        branchName: 'slashdevcorpse/identifying-pwsh.exe-error',
        repoRemoteName: 'origin',
        repoRemoteUrl: 'git@github.com:stablyai/orca.git',
        upstreamName: 'origin/slashdevcorpse/identifying-pwsh.exe-error'
      })
    ).toBe(
      'https://github.com/stablyai/orca/compare/main...slashdevcorpse/identifying-pwsh.exe-error?expand=1'
    )
  })

  it('opens the GitLab New-MR page on the fork project when the branch was pushed to a fork', () => {
    expect(
      buildSourceControlManualReviewUrl({
        baseRef: 'refs/remotes/upstream/main',
        branchName: 'feature/fork-head',
        repoRemoteName: 'upstream',
        repoRemoteUrl: 'git@gitlab.company.test:group/sub/orca.git',
        provider: 'gitlab',
        pushTarget: {
          remoteName: 'fork',
          branchName: 'feature/fork-head',
          remoteUrl: 'git@gitlab.company.test:contributor/orca.git'
        }
      })
      // On the fork project — not group/sub/orca, where source_branch would 404.
    ).toBe(
      'https://gitlab.company.test/contributor/orca/-/merge_requests/new?merge_request%5Bsource_branch%5D=feature%2Ffork-head&merge_request%5Btarget_branch%5D=main'
    )
  })

  it('suppresses the link when the branch tracks a fork remote with no resolvable push URL', () => {
    // A fork-only tracked branch without pushTarget would 404 through the base-repo compare URL.
    expect(
      buildSourceControlManualReviewUrl({
        baseRef: 'refs/remotes/origin/main',
        branchName: 'quick-commands',
        repoRemoteName: 'origin',
        repoRemoteUrl: 'https://github.com/stablyai/orca.git',
        upstreamName: 'pr-devajmeireles-orca/quick-commands'
      })
    ).toBeNull()
  })

  it('uses the pushed upstream branch name when the local branch tracks a differently named branch on the base remote', () => {
    expect(
      buildSourceControlManualReviewUrl({
        baseRef: 'refs/remotes/origin/main',
        branchName: 'local-wip-name',
        repoRemoteName: 'origin',
        repoRemoteUrl: 'git@github.com:stablyai/orca.git',
        upstreamName: 'origin/feature/pushed-name'
      })
    ).toBe('https://github.com/stablyai/orca/compare/main...feature/pushed-name?expand=1')
  })

  it('opens the Azure DevOps PR form for a vs-ssh.visualstudio.com remote', () => {
    expect(
      buildSourceControlManualReviewUrl({
        baseRef: 'refs/remotes/origin/main',
        branchName: 'feature',
        repoRemoteName: 'origin',
        repoRemoteUrl: 'myorg@vs-ssh.visualstudio.com:v3/myorg/Proj/Repo',
        upstreamName: 'origin/feature'
      })
    ).toBe(
      'https://myorg.visualstudio.com/Proj/_git/Repo/pullrequestcreate?sourceRef=refs%2Fheads%2Ffeature&targetRef=refs%2Fheads%2Fmain'
    )
  })
})

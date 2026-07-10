import { describe, expect, it } from 'vitest'
import {
  buildSourceControlManualReviewUrl,
  buildSourceControlManualReviewUrlFromContext,
  resolveSourceControlManualReviewProvider
} from './source-control-manual-review-url'

describe('resolveSourceControlManualReviewProvider', () => {
  it('prefers hosted review and creation providers over linked review hints', () => {
    expect(
      resolveSourceControlManualReviewProvider({
        hostedReviewProvider: 'gitlab',
        hostedReviewCreationProvider: 'github',
        linkedGitLabMR: 12
      })
    ).toBe('gitlab')
    expect(
      resolveSourceControlManualReviewProvider({
        hostedReviewCreationProvider: 'bitbucket',
        linkedGitLabMR: 12
      })
    ).toBe('bitbucket')
  })

  it('falls back through linked review metadata when no hosted provider is known', () => {
    expect(
      resolveSourceControlManualReviewProvider({
        linkedGitLabMR: 12
      })
    ).toBe('gitlab')
    expect(
      resolveSourceControlManualReviewProvider({
        linkedBitbucketPR: 3
      })
    ).toBe('bitbucket')
    expect(
      resolveSourceControlManualReviewProvider({
        linkedAzureDevOpsPR: 7
      })
    ).toBe('azure-devops')
    expect(
      resolveSourceControlManualReviewProvider({
        linkedGiteaPR: 2
      })
    ).toBe('gitea')
    expect(
      resolveSourceControlManualReviewProvider({
        linkedGitHubPR: 42
      })
    ).toBe('github')
    expect(
      resolveSourceControlManualReviewProvider({
        fallbackGitHubPRNumber: 42
      })
    ).toBe('github')
  })

  it('returns null when there is no provider hint', () => {
    expect(resolveSourceControlManualReviewProvider({})).toBeNull()
  })
})

describe('buildSourceControlManualReviewUrlFromContext', () => {
  it('resolves the provider from linked review metadata before building the URL', () => {
    expect(
      buildSourceControlManualReviewUrlFromContext({
        linkedBitbucketPR: 3,
        baseRef: 'origin/main',
        branchName: 'feature/bitbucket',
        repoRemoteName: 'origin',
        repoRemoteUrl: 'git@bitbucket.org:team/project.git',
        upstreamName: 'origin/feature/bitbucket'
      })
    ).toBe(
      'https://bitbucket.org/team/project/pull-requests/new?source=feature%2Fbitbucket&dest=main'
    )
  })
})

describe('buildSourceControlManualReviewUrl', () => {
  it('builds a GitHub compare URL for the current remote branch', () => {
    expect(
      buildSourceControlManualReviewUrl({
        baseRef: 'refs/remotes/origin/main',
        branchName: 'native-chat-does-not-auto-open',
        repoRemoteName: 'origin',
        repoRemoteUrl: 'git@github.com:stablyai/orca.git',
        upstreamName: 'origin/native-chat-does-not-auto-open'
      })
    ).toBe(
      'https://github.com/stablyai/orca/compare/main...native-chat-does-not-auto-open?expand=1'
    )
  })

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

  it('builds a GitLab merge request URL for a self-hosted GitLab remote', () => {
    expect(
      buildSourceControlManualReviewUrl({
        baseRef: 'refs/remotes/origin/release/next',
        branchName: 'feature/gitlab',
        repoRemoteName: 'origin',
        repoRemoteUrl: 'git@gitlab.company.test:group/sub/orca.git',
        provider: 'gitlab',
        upstreamName: 'origin/feature/gitlab'
      })
    ).toBe(
      'https://gitlab.company.test/group/sub/orca/-/merge_requests/new?merge_request%5Bsource_branch%5D=feature%2Fgitlab&merge_request%5Btarget_branch%5D=release%2Fnext'
    )
  })

  it('builds a Bitbucket manual pull request URL', () => {
    expect(
      buildSourceControlManualReviewUrl({
        baseRef: 'origin/main',
        branchName: 'feature/bitbucket',
        repoRemoteName: 'origin',
        repoRemoteUrl: 'git@bitbucket.org:team/project.git',
        upstreamName: 'origin/feature/bitbucket'
      })
    ).toBe(
      'https://bitbucket.org/team/project/pull-requests/new?source=feature%2Fbitbucket&dest=main'
    )
  })

  it('builds an Azure DevOps pull request creation URL', () => {
    expect(
      buildSourceControlManualReviewUrl({
        baseRef: 'refs/remotes/origin/main',
        branchName: 'feature/azure',
        repoRemoteName: 'origin',
        repoRemoteUrl: 'git@ssh.dev.azure.com:v3/acme/widgets/widget-app.git',
        upstreamName: 'origin/feature/azure'
      })
    ).toBe(
      'https://dev.azure.com/acme/widgets/_git/widget-app/pullrequestcreate?sourceRef=refs%2Fheads%2Ffeature%2Fazure&targetRef=refs%2Fheads%2Fmain'
    )
  })

  it('builds a Gitea compare URL when the provider is known', () => {
    expect(
      buildSourceControlManualReviewUrl({
        baseRef: 'refs/remotes/origin/main',
        branchName: 'feature/gitea',
        repoRemoteName: 'origin',
        repoRemoteUrl: 'ssh://git@gitea.company.test/team/orca.git',
        provider: 'gitea',
        upstreamName: 'origin/feature/gitea'
      })
    ).toBe('https://gitea.company.test/team/orca/compare/main...feature/gitea')
  })

  it('suppresses the link when the branch tracks a fork remote with no resolvable push URL', () => {
    // Repro: branch pushed only to a fork (tracked via plain git, so pushTarget
    // is empty). A base-repo compare/main...quick-commands would 404 on origin.
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

  it('still qualifies the fork head when Orca resolved the fork push URL', () => {
    expect(
      buildSourceControlManualReviewUrl({
        baseRef: 'refs/remotes/origin/main',
        branchName: 'quick-commands',
        repoRemoteName: 'origin',
        repoRemoteUrl: 'https://github.com/stablyai/orca.git',
        upstreamName: 'pr-devajmeireles-orca/quick-commands',
        pushTarget: {
          remoteName: 'pr-devajmeireles-orca',
          branchName: 'quick-commands',
          remoteUrl: 'git@github.com:devajmeireles/orca.git'
        }
      })
    ).toBe('https://github.com/stablyai/orca/compare/main...devajmeireles:quick-commands?expand=1')
  })

  it('does not guess a provider for unknown hosts without a provider hint', () => {
    expect(
      buildSourceControlManualReviewUrl({
        baseRef: 'refs/remotes/origin/main',
        branchName: 'feature/unknown',
        repoRemoteName: 'origin',
        repoRemoteUrl: 'git@git.company.test:team/orca.git',
        upstreamName: 'origin/feature/unknown'
      })
    ).toBeNull()
  })

  it('suppresses the link when the branch was never pushed (no upstream, no push target)', () => {
    // Repro: local-only branch. main...<local-branch> lands on GitHub's
    // "There isn't anything to compare" page.
    expect(
      buildSourceControlManualReviewUrl({
        baseRef: 'refs/remotes/origin/main',
        branchName: 'codex-runtime-home-refactor-design',
        repoRemoteName: 'origin',
        repoRemoteUrl: 'git@github.com:stablyai/orca.git',
        upstreamName: null
      })
    ).toBeNull()
  })
})

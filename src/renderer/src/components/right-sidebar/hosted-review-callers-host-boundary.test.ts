import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

function readSource(relativePath: string): string {
  return readFileSync(join(__dirname, relativePath), 'utf8')
}

function expectEveryCallToCarryExecutionHost(source: string, callName: string): void {
  let cursor = 0
  let callCount = 0
  while (true) {
    const callStart = source.indexOf(`${callName}(`, cursor)
    if (callStart < 0) {
      break
    }
    callCount += 1
    const optionWindow = source.slice(callStart, callStart + 500)
    expect(optionWindow, `${callName} call #${callCount}`).toContain('executionHostId')
    cursor = callStart + callName.length + 1
  }
  expect(callCount).toBeGreaterThan(0)
}

describe('hosted-review caller host boundaries', () => {
  it('propagates concrete owners from worktree cards', () => {
    const source = readSource('../sidebar/WorktreeCard.tsx')
    expectEveryCallToCarryExecutionHost(source, 'fetchHostedReviewForBranch')
  })

  it('resolves the checks-panel repo through the active worktree owner and propagates it', () => {
    const source = readSource('ChecksPanel.tsx')
    expect(source).toContain('findRepoForWorktreeOwner(s.repos, activeWorktree)')
    expectEveryCallToCarryExecutionHost(source, 'fetchHostedReviewForBranch')
    expectEveryCallToCarryExecutionHost(source, 'refreshHostedReviewCard')
    expectEveryCallToCarryExecutionHost(source, 'fetchPRChecks')
    expectEveryCallToCarryExecutionHost(source, 'getHostedReviewCreationEligibility')
    expectEveryCallToCarryExecutionHost(source, 'createHostedReview')
    expectEveryCallToCarryExecutionHost(source, 'workItemDetails')
    expectEveryCallToCarryExecutionHost(source, 'resolveMRDiscussion')
  })

  it('routes GitLab runtime review calls through the active worktree owner', () => {
    const source = readSource('ChecksPanel.tsx')
    // Why: these helpers are component-local, so source boundaries pin both runtime RPC call sites.
    const detailsCallStart = source.indexOf('const details = await fetchGitLabMRDetailsForChecks')
    const resolveCallStart = source.indexOf(
      'const result = await resolveGitLabMRDiscussionForChecks'
    )
    const detailsCall = source.slice(detailsCallStart, detailsCallStart + 400)
    const resolveCall = source.slice(resolveCallStart, resolveCallStart + 400)

    expect(detailsCallStart).toBeGreaterThan(-1)
    expect(resolveCallStart).toBeGreaterThan(-1)
    expect(detailsCall).toContain('settings: ownerSettings')
    expect(resolveCall).toContain('settings: ownerSettings')
  })

  it('scopes checks-panel recipe persistence to the active repository host', () => {
    const source = readSource('ChecksPanel.tsx')
    const callbackStart = source.indexOf('const saveLaunchActionDefault')
    const callbackEnd = source.indexOf('const asyncResultKeyRef', callbackStart)
    const callback = source.slice(callbackStart, callbackEnd)

    expect(callback).toContain('findRepoForHost(state.repos, target.repoId')
    expect(callback).toContain('hostId: repo ? getRepoExecutionHostId(repo) : undefined')
    expect(callback).toMatch(/updateRepo\(result\.target\.repoId, result\.update, \{[\s\S]*hostId:/)
    expect(source).toContain('repo={repo}')
  })

  it('resolves the source-control repo through the active worktree owner and propagates it', () => {
    const source = readSource('SourceControl.tsx')
    expect(source).toContain('findRepoForWorktreeOwner(s.repos, activeWorktree)')
    expect(source).toContain('repo={activeRepo}')
    expectEveryCallToCarryExecutionHost(source, 'fetchHostedReviewForBranch')
    expectEveryCallToCarryExecutionHost(source, 'getHostedReviewCreationEligibility')
    expectEveryCallToCarryExecutionHost(source, 'createHostedReview')
  })

  it('scopes PR-check repository selection to the requested execution host', () => {
    const source = readSource('../../store/slices/github.ts')
    expect(source).toContain('getRepoExecutionHostId(candidate) === executionHostId')
    expect(source).toContain('if (options?.executionHostId && !repo)')
    expect(source).toMatch(/window\.api\.gh\.prChecks\(\{[\s\S]{0,300}executionHostId:/)
  })

  it('resolves TaskPage PR checks through the work-item owner', () => {
    const source = readSource('../TaskPage.tsx')
    expect(source).toContain('findTaskPageRepoForWorkItem(repos, item)')
    expectEveryCallToCarryExecutionHost(source, 'fetchPRChecks')
  })

  it('propagates the checks-panel owner through every repo-scoped PR operation', () => {
    const source = readSource('./ChecksPanel.tsx')
    for (const call of [
      'fetchPRForBranch',
      'fetchPRCheckDetails',
      'fetchPRComments',
      'addPRConversationComment',
      'addPRReviewCommentReply',
      'resolveReviewThread'
    ]) {
      expectEveryCallToCarryExecutionHost(source, call)
    }
  })

  it('propagates owners from source-control and folder-workspace PR operations', () => {
    expectEveryCallToCarryExecutionHost(readSource('./SourceControl.tsx'), 'fetchPRForBranch')
    expectEveryCallToCarryExecutionHost(
      readSource('./FolderWorkspacePrChecksPanel.tsx'),
      'fetchPRCheckDetails'
    )
  })

  it('propagates canonical owners through background PR and issue refreshes', () => {
    expectEveryCallToCarryExecutionHost(
      readSource('../../store/slices/github.ts'),
      'get().fetchPRForBranch'
    )
    expectEveryCallToCarryExecutionHost(
      readSource('../../store/slices/github.ts'),
      'get().fetchIssue'
    )
    expectEveryCallToCarryExecutionHost(readSource('../sidebar/WorktreeCard.tsx'), 'fetchIssue')
  })

  it('uses worktree ownership for terminal links, check reloads, and linked issues', () => {
    for (const sourcePath of [
      '../../store/slices/worktrees.ts',
      '../../store/slices/editor.ts',
      '../sidebar/use-worktree-issue-link.ts'
    ]) {
      const source = readSource(sourcePath)
      expect(source).toContain('findRepoForWorktreeOwner')
      expect(source).toContain('executionHostId')
    }
  })
})

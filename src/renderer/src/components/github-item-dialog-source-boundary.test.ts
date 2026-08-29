import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const COMPONENT_ROOT = __dirname

function componentSource(relativePath: string): string {
  // Why: CRLF checkouts would otherwise break every multi-line source assertion.
  return readFileSync(join(COMPONENT_ROOT, relativePath), 'utf8').replace(/\r\n?/g, '\n')
}

function destSources(...relativePaths: string[]): string {
  return relativePaths.map((relativePath) => componentSource(relativePath)).join('\n')
}

function sourceBetween(source: string, startPattern: string, endPattern: string): string {
  const start = source.indexOf(startPattern)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = source.indexOf(endPattern, start + startPattern.length)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('GitHubItemDialog source host boundaries', () => {
  it('does not keep the stale right-side sheet owner', () => {
    const source = destSources(
      'GitHubItemDialog.tsx',
      'github-item-dialog/open-dialog/github-item-dialog.tsx'
    )

    expect(source).not.toContain('@/components/ui/sheet')
    expect(source).not.toContain('<Sheet')
    expect(source).not.toContain('<SheetContent')
    expect(source).not.toContain("variant?: 'sheet'")
  })

  it('routes reviewer metadata and reviewer mutations through the task source context', () => {
    const source = destSources(
      'github-item-dialog/land-pull-request/pr-reviewers-panel.tsx',
      'github-item-dialog/land-pull-request/pr-reviewers-request-actions.ts'
    )
    const section = source

    expect(section).toContain('getTaskSourceRuntimeSettings(sourceContext)')
    expect(section).toContain('useRepoAssigneesBySlug(')
    expect(section).toContain('sourceSettings')
    expect(section).toContain('useRepoAssignees(')
    expect(section).toContain('sourceSettings')
    expect(section).toContain('getActiveRuntimeTarget(sourceSettings)')
    expect(section).toContain(
      'const runtimeRepo = getGitHubRuntimeRepoId(sourceContext, item.repoId)'
    )
    expect(section).toContain("'github.requestPRReviewers'")
    expect(section).toContain("'github.removePRReviewers'")
    expect(section).toContain('resolvePullRequestRepo(item, projectOrigin)')
    expect(section.match(/prRepo: reviewRepo/g)).toHaveLength(4)
    expect(section).toContain('notifyWorkItemDetailsMutation(')
    expect(section).toContain('{ local: false }')
  })

  it('routes edit metadata through the same task source as issue mutations', () => {
    const source = destSources(
      'github-item-dialog/edit-item-fields/gh-edit-section.tsx',
      'github-item-dialog/edit-item-fields/gh-edit-section-mutations.ts'
    )
    const section = source
    const helperSection = componentSource('github/github-work-item-edit-mutations.ts')

    expect(section).toContain('getTaskSourceRuntimeSettings(sourceContext)')
    expect(section).toContain('useRepoLabels(')
    expect(section).toContain('useRepoLabelsBySlug(')
    expect(section).toContain('projectOrigin?.host')
    expect(section).toContain('useRepoAssignees(')
    expect(section).toContain('useRepoAssigneesBySlug(')
    expect(section).toContain('sourceSettings')
    expect(helperSection).toContain("'github.updateIssue'")
    expect(helperSection).toContain("'github.updatePRState'")
    expect(helperSection).toContain("'github.project.updateIssueBySlug'")
    expect(helperSection).toContain("'github.project.updatePullRequestBySlug'")
    expect(helperSection).toContain("args.sourceContext?.provider === 'github'")
    expect(helperSection).toContain('getTaskSourceRuntimeSettings(args.sourceContext)')
    expect(helperSection).toContain(
      'getGitHubMutationRoutingSettings(useAppStore.getState(), args.repoId, args.sourceContext)'
    )
    expect(helperSection).toContain('notifyWorkItemDetailsMutation(')
    expect(helperSection).toContain(
      "repo: getGitHubRuntimeRepoId(args.sourceContext, args.repoId ?? '')"
    )
    expect(helperSection).toContain('{ local: false }')
  })

  it('uses source-aware details routing and cache identity', () => {
    const source = destSources(
      'github-item-dialog/load-item-details/work-item-details-cache.ts',
      'github-item-dialog/load-item-details/use-github-item-dialog-details.ts'
    )
    const cacheKeySection = sourceBetween(
      source,
      'function getWorkItemDetailsCacheKey',
      'function touchWorkItemDetailsCache'
    )
    const matchInvalidationSection = sourceBetween(
      source,
      'function invalidateWorkItemDetailsCacheByMatch',
      'function patchCachedPRFileViewedState'
    )

    expect(source).toContain('lookupGitHubWorkItemDetailsForSource({')
    expect(source).toContain('sourceContext,')
    expect(cacheKeySection).toContain('sourceCacheScope')
    expect(source).toContain('getTaskSourceCacheScope(sourceContext)')
    expect(matchInvalidationSection).toContain(
      'if (removed) {\n    workItemDetailsCacheGeneration += 1'
    )
  })

  it('treats null details as unavailable while preserving empty detail payloads', () => {
    const source = destSources(
      'github-item-dialog/load-item-details/use-github-item-dialog-details.ts',
      'github-item-dialog/load-item-details/work-item-details-fetch-settle.ts'
    )
    const loadedSection = sourceBetween(
      source,
      'const loading = !!cachedEntry?.pending && !cachedEntry?.details',
      '// Why: if a cross-window mutation invalidates'
    )
    const resultSection = sourceBetween(source, 'inflight', '.catch((err) => {')

    expect(loadedSection).toContain('const detailsLoaded = Boolean(cachedEntry?.details)')
    expect(loadedSection).not.toContain('fetchedAt > 0')
    expect(resultSection).toContain('} else if (result === null) {')
    expect(resultSection).toContain('error: WORK_ITEM_DETAILS_UNAVAILABLE_MESSAGE')
    expect(resultSection).toContain('details: result')
  })

  it('routes PR file viewed mutations through the task source context', () => {
    const changeSection = destSources(
      'github-item-dialog/load-item-details/use-github-item-dialog-details.ts',
      'github-item-dialog/load-item-details/pr-file-viewed-change.ts'
    )
    const helperSection = componentSource('github/github-work-item-comment-mutations.ts')

    expect(helperSection).toContain('getGitHubSourceRuntimeHost(args.sourceContext)')
    expect(helperSection).toContain("'github.setPRFileViewed'")
    expect(helperSection).toContain('repo: getGitHubRuntimeRepoId(args.sourceContext, args.repoId)')
    expect(helperSection).toContain('sourceContext: args.sourceContext')
    expect(helperSection).toContain('{ local: false }')
    expect(changeSection).toContain('canUseDetailsRepoContext')
    expect(changeSection).toContain('repoPath: repoPath ??')
    expect(changeSection).toContain('sourceContext,')
  })

  it('routes comment mutations through runtime source context when needed', () => {
    const helperSource = componentSource('github/github-work-item-comment-mutations.ts')
    const helperSection = sourceBetween(
      helperSource,
      'function addIssueCommentForRepo',
      'function setPRFileViewedForRepo'
    )

    expect(helperSection).toContain('getGitHubSourceRuntimeHost(args.sourceContext)')
    expect(helperSection).toContain("'github.addIssueComment'")
    expect(helperSection).toContain("'github.addPRReviewComment'")
    expect(helperSection).toContain("'github.addPRReviewCommentReply'")
    expect(helperSection).toContain('repo: getGitHubRuntimeRepoId(args.sourceContext, args.repoId)')
    expect(helperSection).toContain('sourceContext: args.sourceContext')
    expect(helperSection).toContain('notifyWorkItemDetailsMutation(')
    expect(helperSection).toContain('{ local: false }')
  })

  it('routes PR file contents and runtime viewed invalidations through the task source context', () => {
    const source = destSources(
      'github-item-dialog/load-item-details/work-item-details-cache.ts',
      'github-item-dialog/load-item-details/pr-file-content-cache.ts'
    )
    const commentMutations = componentSource('github/github-work-item-comment-mutations.ts')
    const fileContentsSection = sourceBetween(
      source,
      'function loadPRFileContents',
      'touchPRFileContentCache(cacheKey, request)'
    )
    const fileContentsCacheKeySection = sourceBetween(
      source,
      'function getPRFileContentCacheKey',
      'function loadPRFileContents'
    )
    const listenerSection = sourceBetween(source, 'let workItemMutatedUnsub', '// Why: bounded LRU')

    expect(fileContentsCacheKeySection).toContain(
      'source:${getTaskSourceCacheScope(args.sourceContext)}'
    )
    expect(fileContentsSection).toContain("'github.prFileContents'")
    expect(fileContentsSection).toContain(
      'repo: getGitHubRuntimeRepoId(args.sourceContext, args.repoId)'
    )
    expect(fileContentsSection).toContain('sourceContext: args.sourceContext')
    expect(fileContentsSection).toContain('sourceContext,')
    expect(listenerSection).toContain('onGitHubWorkItemDetailsCacheMutation')
    expect(commentMutations).toContain('emitGitHubWorkItemDetailsCacheMutation(args)')
    expect(commentMutations).toContain('options.local !== false')
    expect(commentMutations).toContain('notifyWorkItemMutated({')
  })

  it('routes merge actions through the repo owner host (#6957)', () => {
    const actionsSection = componentSource(
      'github-item-dialog/land-pull-request/pr-actions-panel.tsx'
    )

    expect(actionsSection).toContain(
      'getGitHubMutationRoutingSettings(s, item.repoId ?? repoId ?? null, sourceContext)'
    )
    expect(actionsSection).toContain('getActiveRuntimeTarget(sourceSettings)')
    expect(actionsSection).toContain(
      'const canMergeWithRepoContext = !!repoPath || mergeTarget.kind ==='
    )
    expect(actionsSection).toContain("'github.mergePR'")
    expect(actionsSection).toContain("'github.setPRAutoMerge'")
    expect(actionsSection).toContain('const prRepo = resolvePullRequestRepo(item, projectOrigin)')
    expect(actionsSection).not.toContain('prRepo: item.prRepo ?? null')
    expect(actionsSection).toContain(
      'repo: getGitHubRuntimeRepoId(sourceContext, repoId ?? item.repoId)'
    )
    expect(actionsSection).toContain('sourceContext,')
    expect(actionsSection).toContain('notifyWorkItemDetailsMutation(')
    expect(actionsSection).toContain('{ local: false }')
  })

  it('routes check actions through the task source context', () => {
    const checksSection = destSources(
      'github-item-dialog/inspect-pull-request/checks-tab.tsx',
      'github-item-dialog/inspect-pull-request/checks-tab-actions.ts',
      'github-item-dialog/inspect-pull-request/checks-tab-request-details.ts'
    )

    expect(checksSection).toContain('sourceContext?: TaskSourceContext | null')
    expect(checksSection).toContain('sourceContext,')
    expect(checksSection).toContain("'github.prChecks'")
    expect(checksSection).toContain("'github.rerunPRChecks'")
    expect(checksSection).toContain("'github.prCheckDetails'")
    expect(checksSection).toContain(
      'repo: getGitHubRuntimeRepoId(ctx.sourceContext, ctx.repoId ?? ctx.itemRepoId)'
    )
    expect(checksSection).toContain('window.api.gh.prChecks({')
    expect(checksSection).toContain('window.api.gh.rerunPRChecks({')
    expect(checksSection).toContain('prCheckDetails({')
    expect(checksSection).toMatch(
      /withGitHubCheckDetailsTimeout\(\(signal\) =>\s*ctx\.runtimeHost\s*\?\s*callRuntimeRpc[\s\S]*:\s*window\.api\.gh\.prCheckDetails\(\{/
    )
    expect(checksSection).toContain('{ timeoutMs: 30_000, signal }')
  })

  it('makes failed check detail loads retryable and fences stale responses', () => {
    const checksSection = destSources(
      'github-item-dialog/inspect-pull-request/checks-tab.tsx',
      'github-item-dialog/inspect-pull-request/checks-tab-actions.ts',
      'github-item-dialog/inspect-pull-request/checks-tab-request-details.ts',
      'github-item-dialog/inspect-pull-request/checks-tab-check-details.tsx'
    )

    expect(checksSection).toContain('createGitHubChecksTabState(checks, checkDetailsContextKey)')
    expect(checksSection).toContain('checksState,\n    checks,\n    checkDetailsContextKey')
    expect(checksSection).toContain('resetGitHubChecksTabForSource(current)')
    expect(checksSection).toContain(
      'committedChecksContextOwnerRef.current !== refreshContextOwner'
    )
    expect(checksSection).toContain('activeChecksRefreshRequestIdRef.current !== refreshRequestId')
    expect(checksSection).toContain('current.contextOwner === refreshContextOwner')
    expect(checksSection).toContain(
      'const rerunContextOwner = ctx.committedChecksContextOwnerRef.current'
    )
    expect(checksSection).toContain(
      'ctx.committedChecksContextOwnerRef.current !== rerunContextOwner'
    )
    expect(checksSection).toContain('await refreshGitHubChecksTab(ctx, rerunContextOwner)')
    expect(checksSection).toContain('!ctx.mountedRef.current ||')
    expect(checksSection).toContain('settleGitHubChecksTabDetails(current, key, requestId, next)')
    expect(checksSection).toContain('onClick={() => onRetry(check, getCheckDetailsKey(check))}')
    expect(checksSection).toContain('disabled={state.loading}')
    expect(checksSection).toContain('aria-busy={state.loading}')
    expect(checksSection).toContain("translate('githubChecks.retrying', 'Retrying…')")
    expect(checksSection).toContain("'Retry'")
  })

  it('uses hydrated work item details for the page checks tab', () => {
    const source = componentSource('github-item-dialog/open-dialog/github-item-dialog-pr-tabs.tsx')
    const checksTab = sourceBetween(
      source,
      '<TabsContent value="checks"',
      '<TabsContent value="files"'
    )

    expect(checksTab).toContain('item={displayWorkItem ?? workItem}')
  })

  it('records state authority for dialog state mutations so stale list refetches cannot revert them (STA-3343)', () => {
    const editSection = destSources(
      'github-item-dialog/edit-item-fields/gh-edit-section.tsx',
      'github-item-dialog/edit-item-fields/gh-edit-section-mutations.ts'
    )
    expect(editSection).toContain('assertTaskPageGitHubDialogStateAuthority({')
    expect(editSection).toContain('if (authority?.revert())')

    const actionsSection = componentSource(
      'github-item-dialog/land-pull-request/pr-actions-panel.tsx'
    )
    expect(actionsSection.match(/assertTaskPageGitHubDialogStateAuthority\(\{/g)).toHaveLength(2)
    expect(actionsSection).toContain('if (authority.revert())')
    expect(actionsSection).toContain("state: 'merged'")
  })
})

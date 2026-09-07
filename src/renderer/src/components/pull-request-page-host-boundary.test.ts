import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const COMPONENT_ROOT = __dirname

function componentSource(relativePath: string): string {
  return readFileSync(join(COMPONENT_ROOT, relativePath), 'utf8')
}

function joinedSource(relativePaths: string[]): string {
  return relativePaths.map(componentSource).join('\n')
}

function sourceBetween(source: string, startPattern: string, endPattern: string): string {
  const start = source.indexOf(startPattern)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = source.indexOf(endPattern, start + startPattern.length)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

const reviewersSource = joinedSource([
  'pull-request-page/reviewers/panel.tsx',
  'pull-request-page/reviewers/request-actions.ts',
  'pull-request-page/reviewers/picker.tsx',
  'pull-request-page/reviewers/requested-list.tsx'
])

const editSource = joinedSource([
  'pull-request-page/edit/section.tsx',
  'pull-request-page/edit/issue-updates.ts'
])

const actionsSource = joinedSource([
  'pull-request-page/actions/panel.tsx',
  'pull-request-page/actions/merge-actions.ts'
])

const conversationSource = joinedSource([
  'pull-request-page/conversation/tab.tsx',
  'pull-request-page/conversation/reply.ts',
  'pull-request-page/conversation/comment-card.tsx'
])

const detailsSource = joinedSource([
  'pull-request-page/page-types.ts',
  'pull-request-page/cache/work-item-details.ts',
  'pull-request-page/page/use-details.ts',
  'pull-request-page/page/surface.tsx'
])

const filesSource = joinedSource([
  'pull-request-page/cache/file-content.ts',
  'pull-request-page/files/section-loader.ts',
  'pull-request-page/files/combined-diff-viewer.tsx',
  'pull-request-page/page/viewed-sync.ts'
])

const commentsSource = joinedSource([
  'pull-request-page/comments/composer.tsx',
  'pull-request-page/conversation/reply.ts',
  'pull-request-page/files/line-comment.ts'
])

const checksSource = joinedSource([
  'pull-request-page/checks/tab.tsx',
  'pull-request-page/checks/refresh.ts',
  'pull-request-page/checks/rerun.ts',
  'pull-request-page/checks/details-request.ts',
  'pull-request-page/checks/details.tsx',
  'pull-request-page/checks/row.tsx'
])

describe('PullRequestPage host boundaries', () => {
  it('routes reviewer metadata and mutations through the PR repo owner host', () => {
    const section = reviewersSource

    expect(section).toContain('getTaskSourceRuntimeSettings(sourceContext)')
    expect(section).toContain('useRepoAssigneesBySlug(')
    expect(section).toContain('sourceSettings')
    expect(section).toContain('useRepoAssignees(')
    expect(section).toContain('sourceSettings')
    expect(section).toContain('getActiveRuntimeTarget(sourceSettings)')
    expect(section).toContain('sourceContext,')
    expect(section).toContain(
      'args.patchWorkItem(args.item.id, { reviewRequests: nextReviewRequests }, args.item.repoId, {'
    )
    expect(section).toContain(
      'const runtimeRepo = getGitHubRuntimeRepoId(args.sourceContext, args.item.repoId)'
    )
    expect(section).toContain("'github.requestPRReviewers'")
    expect(section).toContain("'github.removePRReviewers'")
    expect(section).toContain('resolvePullRequestRepo(item, projectOrigin)')
    expect(section.match(/prRepo: args\.reviewRepo/g)).toHaveLength(4)
    expect(section).toContain('notifyWorkItemDetailsMutation(')
    expect(section).toContain('{ local: false }')
  })

  it('routes PR edit metadata through the same repo owner host as mutations', () => {
    const section = editSource

    expect(section).toContain('getSettingsForRepoRuntimeOwner(s, item.repoId ?? repoId ?? null)')
    expect(section).toContain('getTaskSourceRuntimeSettings(sourceContext)')
    expect(section).toContain('useRepoLabels(')
    expect(section).toContain('useRepoLabelsBySlug(')
    expect(section).toContain('projectOrigin?.host')
    expect(section).toContain('useRepoAssignees(')
    expect(section).toContain('useRepoAssigneesBySlug(')
    expect(section).toContain('sourceSettings')
  })

  it('source-scopes full-page optimistic work item patches', () => {
    const prAssigneesSection = componentSource('github/PRAssigneesPanel.tsx')

    expect(prAssigneesSection).toContain(
      'patchWorkItem(item.id, { assignees: nextAssignees }, item.repoId, { sourceContext })'
    )
    expect(actionsSource).toContain(
      'patchWorkItem(item.id, { state }, item.repoId, { sourceContext })'
    )
    expect(editSource).toContain(
      'args.patchWorkItem(args.item.id, { state: args.newState }, args.item.repoId, {'
    )
    expect(editSource).toContain('args.patchWorkItem(args.item.id, { labels }, args.item.repoId, {')
  })

  it('routes PR mention metadata through the PR repo owner host', () => {
    const section = conversationSource

    expect(section).toContain('getSettingsForRepoRuntimeOwner(s, item.repoId ?? repoId ?? null)')
    expect(section).toContain('useRepoAssignees(repoPath, item.repoId, sourceSettings)')
  })

  it('uses source-aware initial details routing and cache identity', () => {
    const propsSection = componentSource('pull-request-page/page-types.ts')
    const cacheKeySection = sourceBetween(
      componentSource('pull-request-page/cache/work-item-details.ts'),
      'export function getWorkItemDetailsCacheKey',
      'export function touchWorkItemDetailsCache'
    )
    const matchInvalidationSection = sourceBetween(
      componentSource('pull-request-page/cache/work-item-details.ts'),
      'export function invalidateWorkItemDetailsCacheByMatch',
      'export function patchCachedPRFileViewedState'
    )

    expect(propsSection).toContain('sourceContext?: TaskSourceContext | null')
    expect(detailsSource).toContain('lookupGitHubWorkItemDetailsForSource({')
    expect(detailsSource).toContain('sourceContext,')
    expect(cacheKeySection).toContain('sourceCacheScope')
    expect(detailsSource).toContain('getTaskSourceCacheScope(sourceContext)')
    expect(matchInvalidationSection).toContain(
      'if (removed) {\n    workItemDetailsCacheGeneration.current += 1'
    )
  })

  it('treats null details as unavailable while preserving empty detail payloads', () => {
    const loadedSection = sourceBetween(
      componentSource('pull-request-page/page/use-details.ts'),
      'const loading = !!cachedEntry?.pending && !cachedEntry?.details',
      '// Why: if a cross-window mutation invalidates'
    )
    const resultSection = sourceBetween(
      componentSource('pull-request-page/page/use-details.ts'),
      'inflight',
      '.catch((err) => {'
    )

    expect(loadedSection).toContain('const detailsLoaded = Boolean(cachedEntry?.details)')
    expect(loadedSection).not.toContain('fetchedAt > 0')
    expect(resultSection).toContain('} else if (result === null) {')
    expect(resultSection).toContain('error: WORK_ITEM_DETAILS_UNAVAILABLE_MESSAGE')
    expect(resultSection).toContain('details: result')
  })

  it('routes file viewed mutations through the PR source context', () => {
    const helperSection = componentSource('github/github-work-item-comment-mutations.ts')
    const changeSection = sourceBetween(
      componentSource('pull-request-page/page/viewed-sync.ts'),
      'export async function syncPullRequestFileViewed',
      'args.setPendingViewedPaths((prev) => {'
    )

    expect(helperSection).toContain('getGitHubSourceRuntimeHost(args.sourceContext)')
    expect(helperSection).toContain("'github.setPRFileViewed'")
    expect(helperSection).toContain('repo: getGitHubRuntimeRepoId(args.sourceContext, args.repoId)')
    expect(helperSection).toContain('sourceContext: args.sourceContext')
    expect(helperSection).toContain('{ local: false }')
    expect(changeSection).toContain('canUseDetailsRepoContext')
    expect(changeSection).toContain('repoPath: args.repoPath ??')
    expect(changeSection).toContain('sourceContext: args.sourceContext')
  })

  it('routes comment mutations through runtime source context when needed', () => {
    const helperSection = sourceBetween(
      componentSource('github/github-work-item-comment-mutations.ts'),
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
    expect(filesSource).toContain('sourceContext,')
    expect(conversationSource).toContain('sourceContext,')
    expect(commentsSource).toContain('sourceContext,')
  })

  it('routes PR file contents and runtime viewed invalidations through the PR source context', () => {
    const commentMutations = componentSource('github/github-work-item-comment-mutations.ts')
    const fileContentsSection = sourceBetween(
      componentSource('pull-request-page/cache/file-content.ts'),
      'export function loadPRFileContents',
      'touchPRFileContentCache(cacheKey, request)'
    )
    const fileContentsCacheKeySection = sourceBetween(
      componentSource('pull-request-page/cache/file-content.ts'),
      'export function getPRFileContentCacheKey',
      'export function loadPRFileContents'
    )
    const listenerSection = sourceBetween(
      componentSource('pull-request-page/cache/work-item-details.ts'),
      'let workItemMutatedUnsub',
      'if (import.meta !== undefined && import.meta.hot)'
    )
    const commentContextSection = sourceBetween(
      componentSource('github/CommentCodeContext.tsx'),
      'function CommentCodeContext',
      'const resolvedContextExpansionState'
    )

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
    expect(commentContextSection).toContain('sourceContext?: TaskSourceContext | null')
    expect(commentContextSection).toMatch(
      /loadPRFileContents\(\{\s*repoPath,\s*repoId,\s*sourceContext,\s*prNumber,\s*prRepo,/
    )
  })

  it('routes check actions through the PR source context', () => {
    expect(checksSource).toContain('sourceContext?: TaskSourceContext | null')
    expect(checksSource).toContain('sourceContext,')
    expect(checksSource).toContain("'github.prChecks'")
    expect(checksSource).toContain("'github.rerunPRChecks'")
    expect(checksSource).toContain("'github.prCheckDetails'")
    expect(checksSource).toContain(
      'repo: getGitHubRuntimeRepoId(args.sourceContext, args.repoId ?? args.item.repoId)'
    )
    expect(checksSource).toContain('window.api.gh.prChecks({')
    expect(checksSource).toContain('window.api.gh.rerunPRChecks({')
    expect(checksSource).toContain('prCheckDetails({')
    expect(checksSource).toMatch(
      /withGitHubCheckDetailsTimeout\(\(signal\) =>\s*args\.runtimeHost\s*\?\s*callRuntimeRpc[\s\S]*:\s*window\.api\.gh\.prCheckDetails\(\{/
    )
    expect(checksSource).toContain('{ timeoutMs: 30_000, signal }')
  })

  it('makes failed check detail loads retryable and fences stale settlements', () => {
    expect(checksSource).toContain('const requestId = ++args.nextCheckDetailsRequestIdRef.current')
    expect(checksSource).toContain('settleGitHubChecksTabDetails(current, args.key, requestId')
    expect(checksSource).toContain('createGitHubChecksTabState(checks, checkDetailsContextKey)')
    expect(checksSource).toContain('checksState,\n    checks,\n    checkDetailsContextKey')
    expect(checksSource).toContain('resetGitHubChecksTabForSource(current)')
    expect(checksSource).toContain(
      'args.committedChecksContextOwnerRef.current !== refreshContextOwner'
    )
    expect(checksSource).toContain(
      'args.activeChecksRefreshRequestIdRef.current !== refreshRequestId'
    )
    expect(checksSource).toContain('current.contextOwner === refreshContextOwner')
    expect(checksSource).toContain(
      'const rerunContextOwner = args.committedChecksContextOwnerRef.current'
    )
    expect(checksSource).toContain(
      'args.committedChecksContextOwnerRef.current !== rerunContextOwner'
    )
    expect(checksSource).toContain('await args.handleRefresh(rerunContextOwner)')
    expect(checksSource).toContain('!args.mountedRef.current ||')
    expect(checksSource).toContain('onClick={() => onRetry(check, getCheckDetailsKey(check))}')
    expect(checksSource).toContain('disabled={state.loading}')
    expect(checksSource).toContain('aria-busy={state.loading}')
    expect(checksSource).toContain("translate('githubChecks.retrying', 'Retrying…')")
    expect(checksSource).toContain(
      "translate('auto.components.PullRequestPage.5df7c41d2a', 'Retry')"
    )
  })

  it('routes edit metadata and mutations through the PR source context', () => {
    const editHelperSection = componentSource('github/github-work-item-edit-mutations.ts')

    expect(editHelperSection).toContain("'github.updateIssue'")
    expect(editHelperSection).toContain("'github.updatePRState'")
    expect(editHelperSection).toContain("'github.project.updateIssueBySlug'")
    expect(editHelperSection).toContain("'github.project.updatePullRequestBySlug'")
    expect(editHelperSection).toContain('host: githubProjectHost(args.projectOrigin.host)')
    expect(editHelperSection).toContain('host: githubProjectHost(targetSlug.host)')
    expect(editHelperSection).toContain('sourceContext?: TaskSourceContext | null')
    expect(editHelperSection).toContain("args.sourceContext?.provider === 'github'")
    expect(editHelperSection).toContain('getTaskSourceRuntimeSettings(args.sourceContext)')
    expect(editHelperSection).toContain(
      'getGitHubMutationRoutingSettings(useAppStore.getState(), args.repoId, args.sourceContext)'
    )
    expect(editHelperSection).toContain(
      "repo: getGitHubRuntimeRepoId(args.sourceContext, args.repoId ?? '')"
    )
    expect(editHelperSection).toContain('{ local: false }')
    expect(editSource).toContain('getTaskSourceRuntimeSettings(sourceContext)')
    expect(editSource).toContain('sourceContext,')
  })

  it('routes merge actions through the repo owner host (#6957)', () => {
    expect(actionsSource).toContain(
      'getGitHubMutationRoutingSettings(s, item.repoId ?? repoId ?? null, sourceContext)'
    )
    expect(actionsSource).toContain('getActiveRuntimeTarget(sourceSettings)')
    expect(actionsSource).toContain(
      'const canMergeWithRepoContext = !!repoPath || mergeTarget.kind ==='
    )
    expect(actionsSource).toContain("'github.mergePR'")
    expect(actionsSource).toContain("'github.setPRAutoMerge'")
    expect(actionsSource).toContain('const prRepo = resolvePullRequestRepo(item, projectOrigin)')
    expect(actionsSource).not.toContain('prRepo: item.prRepo ?? null')
    expect(actionsSource).toContain(
      'repo: getGitHubRuntimeRepoId(args.sourceContext, args.repoId ?? args.item.repoId)'
    )
    expect(actionsSource).toContain('sourceContext,')
    expect(actionsSource).toContain('notifyWorkItemDetailsMutation(')
    expect(actionsSource).toContain('{ local: false }')
  })
})

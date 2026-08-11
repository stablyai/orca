import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const COMPONENT_ROOT = __dirname

function componentSource(relativePath: string): string {
  return readFileSync(join(COMPONENT_ROOT, relativePath), 'utf8')
}

function sourceBetween(source: string, startPattern: string, endPattern: string): string {
  const start = source.indexOf(startPattern)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = source.indexOf(endPattern, start + startPattern.length)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('PullRequestPage host boundaries', () => {
  it('routes reviewer metadata and mutations through the PR repo owner host', () => {
    const source = componentSource('PullRequestPage.tsx')
    const section = sourceBetween(
      source,
      'function PRReviewersPanel',
      'const WORK_ITEM_DETAILS_CACHE_MAX'
    )

    expect(section).toContain('getTaskSourceRuntimeSettings(sourceContext)')
    expect(section).toContain('useRepoAssigneesBySlug(')
    expect(section).toContain('sourceSettings')
    expect(section).toContain('useRepoAssignees(')
    expect(section).toContain('sourceSettings')
    expect(section).toContain('getActiveRuntimeTarget(sourceSettings)')
    expect(section).toContain('sourceContext,')
    expect(section).toContain(
      'patchWorkItem(item.id, { reviewRequests: nextReviewRequests }, item.repoId, {'
    )
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

  it('routes PR edit metadata through the same repo owner host as mutations', () => {
    const source = componentSource('PullRequestPage.tsx')
    const section = sourceBetween(source, 'function GHEditSection', 'function GHCommentComposer')

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
    const source = componentSource('PullRequestPage.tsx')
    const prAssigneesSection = componentSource('github/PRAssigneesPanel.tsx')
    const prActionsSection = sourceBetween(
      source,
      'function PRActionsPanel',
      'function CommentReplyForm'
    )
    const issueEditSection = sourceBetween(
      source,
      'function GHEditSection',
      'function GHCommentComposer'
    )

    expect(prAssigneesSection).toContain(
      'patchWorkItem(item.id, { assignees: nextAssignees }, item.repoId, { sourceContext })'
    )
    expect(prActionsSection).toContain(
      'patchWorkItem(item.id, { state }, item.repoId, { sourceContext })'
    )
    expect(issueEditSection).toContain(
      'patchWorkItem(item.id, { state: newState }, item.repoId, { sourceContext })'
    )
    expect(issueEditSection).toContain(
      'patchWorkItem(item.id, { labels: newLabels }, item.repoId, { sourceContext })'
    )
  })

  it('routes PR mention metadata through the PR repo owner host', () => {
    const source = componentSource('PullRequestPage.tsx')
    const section = sourceBetween(source, 'function ConversationTab', 'const mentionOptions')

    expect(section).toContain('getSettingsForRepoRuntimeOwner(s, item.repoId ?? repoId ?? null)')
    expect(section).toContain('useRepoAssignees(repoPath, item.repoId, sourceSettings)')
  })

  it('uses source-aware initial details routing and cache identity', () => {
    const source = componentSource('PullRequestPage.tsx')
    const propsSection = sourceBetween(
      source,
      'type PullRequestPageProps',
      'function findMentionQuery'
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

    expect(propsSection).toContain('sourceContext?: TaskSourceContext | null')
    expect(source).toContain('lookupGitHubWorkItemDetailsForSource({')
    expect(source).toContain('sourceContext,')
    expect(cacheKeySection).toContain('sourceCacheScope')
    expect(source).toContain('getTaskSourceCacheScope(sourceContext)')
    expect(matchInvalidationSection).toContain(
      'if (removed) {\n    workItemDetailsCacheGeneration += 1'
    )
  })

  it('treats null details as unavailable while preserving empty detail payloads', () => {
    const source = componentSource('PullRequestPage.tsx')
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

  it('routes file viewed mutations through the PR source context', () => {
    const source = componentSource('PullRequestPage.tsx')
    const helperSection = componentSource('github/github-work-item-comment-mutations.ts')
    const changeSection = sourceBetween(
      source,
      'const handlePRFileViewedChange = useCallback',
      'const ownerRepo = parseOwnerRepoFromItemUrl'
    )

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
    const source = componentSource('PullRequestPage.tsx')
    const helperSection = sourceBetween(
      componentSource('github/github-work-item-comment-mutations.ts'),
      'function addIssueCommentForRepo',
      'function setPRFileViewedForRepo'
    )
    const fileCommentSection = sourceBetween(
      source,
      'const handleAddLineComment = useCallback',
      'const renderViewedCheckbox = useCallback'
    )
    const conversationSection = sourceBetween(
      source,
      'const handleReply = useCallback',
      'const rightPanel ='
    )
    const composerSection = sourceBetween(
      source,
      'const handleSubmit = useCallback',
      'const canSubmitComment ='
    )

    expect(helperSection).toContain('getGitHubSourceRuntimeHost(args.sourceContext)')
    expect(helperSection).toContain("'github.addIssueComment'")
    expect(helperSection).toContain("'github.addPRReviewComment'")
    expect(helperSection).toContain("'github.addPRReviewCommentReply'")
    expect(helperSection).toContain('repo: getGitHubRuntimeRepoId(args.sourceContext, args.repoId)')
    expect(helperSection).toContain('sourceContext: args.sourceContext')
    expect(helperSection).toContain('notifyWorkItemDetailsMutation(')
    expect(helperSection).toContain('{ local: false }')
    expect(fileCommentSection).toContain('sourceContext,')
    expect(conversationSection).toContain('sourceContext,')
    expect(composerSection).toContain('sourceContext,')
  })

  it('routes PR file contents and runtime viewed invalidations through the PR source context', () => {
    const source = componentSource('PullRequestPage.tsx')
    const commentMutations = componentSource('github/github-work-item-comment-mutations.ts')
    const fileContentsSection = sourceBetween(
      source,
      'function loadPRFileContents',
      'type CachedPRFilesDiffViewState'
    )
    const fileContentsCacheKeySection = sourceBetween(
      source,
      'function getPRFileContentCacheKey',
      'function loadPRFileContents'
    )
    const listenerSection = sourceBetween(source, 'let workItemMutatedUnsub', '// Why: bounded LRU')
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
    const source = componentSource('PullRequestPage.tsx')
    const checksSection = sourceBetween(source, 'function ChecksTab', 'function MentionTextarea')

    expect(checksSection).toContain('sourceContext?: TaskSourceContext | null')
    expect(checksSection).toContain('sourceContext,')
    expect(checksSection).toContain("'github.prChecks'")
    expect(checksSection).toContain("'github.rerunPRChecks'")
    expect(checksSection).toContain("'github.prCheckDetails'")
    expect(checksSection).toContain(
      'repo: getGitHubRuntimeRepoId(sourceContext, repoId ?? item.repoId)'
    )
    expect(checksSection).toContain('window.api.gh.prChecks({')
    expect(checksSection).toContain('window.api.gh.rerunPRChecks({')
    expect(checksSection).toContain('prCheckDetails({')
    expect(checksSection).toMatch(
      /withGitHubCheckDetailsTimeout\(\(signal\) =>\s*runtimeHost\s*\?\s*callRuntimeRpc[\s\S]*:\s*window\.api\.gh\.prCheckDetails\(\{/
    )
    expect(checksSection).toContain('{ timeoutMs: 30_000, signal }')
  })

  it('makes failed check detail loads retryable and fences stale settlements', () => {
    const source = componentSource('PullRequestPage.tsx')
    const checksSection = sourceBetween(source, 'function ChecksTab', 'function MentionTextarea')

    expect(checksSection).toContain('const requestId = ++nextCheckDetailsRequestIdRef.current')
    expect(checksSection).toContain('settleGitHubChecksTabDetails(current, key, requestId')
    expect(checksSection).toContain('createGitHubChecksTabState(checks, checkDetailsContextKey)')
    expect(checksSection).toContain('checksState,\n    checks,\n    checkDetailsContextKey')
    expect(checksSection).toContain('resetGitHubChecksTabForSource(current)')
    expect(checksSection).toContain(
      'committedChecksContextOwnerRef.current !== refreshContextOwner'
    )
    expect(checksSection).toContain('activeChecksRefreshRequestIdRef.current !== refreshRequestId')
    expect(checksSection).toContain('current.contextOwner === refreshContextOwner')
    expect(checksSection).toContain(
      'const rerunContextOwner = committedChecksContextOwnerRef.current'
    )
    expect(checksSection).toContain('committedChecksContextOwnerRef.current !== rerunContextOwner')
    expect(checksSection).toContain('await handleRefresh(rerunContextOwner)')
    expect(checksSection).toContain('!mountedRef.current ||')
    expect(checksSection).toContain(
      'onClick={() => requestCheckDetails(check, getCheckDetailsKey(check))}'
    )
    expect(checksSection).toContain('disabled={state.loading}')
    expect(checksSection).toContain('aria-busy={state.loading}')
    expect(checksSection).toContain("translate('githubChecks.retrying', 'Retrying…')")
    expect(checksSection).toContain(
      "translate('auto.components.PullRequestPage.5df7c41d2a', 'Retry')"
    )
  })

  it('routes edit metadata and mutations through the PR source context', () => {
    const source = componentSource('PullRequestPage.tsx')
    const editHelperSection = componentSource('github/github-work-item-edit-mutations.ts')
    const editSection = sourceBetween(
      source,
      'function GHEditSection',
      'function GHCommentComposer'
    )

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
    expect(editSection).toContain('getTaskSourceRuntimeSettings(sourceContext)')
    expect(editSection).toContain('sourceContext,')
  })

  it('routes merge actions through the repo owner host (#6957)', () => {
    const source = componentSource('PullRequestPage.tsx')
    const actionsSection = sourceBetween(
      source,
      'function PRActionsPanel',
      'function CommentReplyForm'
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
})

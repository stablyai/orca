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

describe('GitHubItemDialog source host boundaries', () => {
  it('does not keep the stale right-side sheet owner', () => {
    const source = componentSource('GitHubItemDialog.tsx')

    expect(source).not.toContain('@/components/ui/sheet')
    expect(source).not.toContain('<Sheet')
    expect(source).not.toContain('<SheetContent')
    expect(source).not.toContain("variant?: 'sheet'")
  })

  it('routes reviewer metadata and reviewer mutations through the task source context', () => {
    const source = componentSource('GitHubItemDialog.tsx')
    const section = sourceBetween(source, 'function PRReviewersPanel', 'function isPRFileViewed')

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
    expect(section).toContain('{ repo: runtimeRepo, prNumber: item.number, reviewers: logins }')
    expect(section).toContain('notifyWorkItemDetailsMutation(')
    expect(section).toContain('{ local: false }')
  })

  it('routes edit metadata through the same task source as issue mutations', () => {
    const source = componentSource('GitHubItemDialog.tsx')
    const section = sourceBetween(source, 'function GHEditSection', 'const hasAttachedWorkspace')
    const helperSection = sourceBetween(
      source,
      'function getGitHubMutationSettings',
      'function GitHubLabelsSettingsLink'
    )

    expect(section).toContain('getTaskSourceRuntimeSettings(sourceContext)')
    expect(section).toContain('useRepoLabels(')
    expect(section).toContain('useRepoLabelsBySlug(slugOwner, slugRepo, sourceSettings)')
    expect(section).toContain('useRepoAssignees(')
    expect(section).toContain('useRepoAssigneesBySlug(')
    expect(section).toContain('sourceSettings')
    expect(helperSection).toContain("'github.updateIssue'")
    expect(helperSection).toContain("'github.updatePRState'")
    expect(helperSection).toContain("'github.project.updateIssueBySlug'")
    expect(helperSection).toContain("'github.project.updatePullRequestBySlug'")
    expect(helperSection).toContain("args.sourceContext?.provider === 'github'")
    expect(helperSection).toContain('getTaskSourceRuntimeSettings(args.sourceContext)')
    expect(helperSection).toContain('notifyWorkItemDetailsMutation(')
    expect(helperSection).toContain(
      "repo: getGitHubRuntimeRepoId(args.sourceContext, args.repoId ?? '')"
    )
    expect(helperSection).toContain('{ local: false }')
  })

  it('uses source-aware details routing and cache identity', () => {
    const source = componentSource('GitHubItemDialog.tsx')
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
    expect(matchInvalidationSection).toMatch(
      /if \(removed\) {\s+workItemDetailsCacheGeneration \+= 1/
    )
  })

  it('treats null details as unavailable while preserving empty detail payloads', () => {
    const source = componentSource('GitHubItemDialog.tsx')
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
    const source = componentSource('GitHubItemDialog.tsx')
    const helperSection = sourceBetween(
      source,
      'function setPRFileViewedForRepo',
      'function PRViewedCheckbox'
    )
    const changeSection = sourceBetween(
      source,
      'const handlePRFileViewedChange = useCallback',
      'const isIssuePage = workItem?.type ==='
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
    const source = componentSource('GitHubItemDialog.tsx')
    const helperSection = sourceBetween(
      source,
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
    const source = componentSource('GitHubItemDialog.tsx')
    const fileContentsSection = sourceBetween(
      source,
      'function loadPRFileContents',
      'function setPRFileViewedForRepo'
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
    expect(source).toContain('emitGitHubWorkItemDetailsCacheMutation(args)')
    expect(source).toContain('options.local !== false')
    expect(source).toContain('notifyWorkItemMutated({')
  })

  it('routes merge actions through the task source context', () => {
    const source = componentSource('GitHubItemDialog.tsx')
    const actionsSection = sourceBetween(
      source,
      'function PRActionsPanel',
      'function CommentReactions'
    )

    expect(actionsSection).toContain('getSettingsForRepoRuntimeOwner(s, repoId ?? item.repoId')
    expect(actionsSection).toContain('...repoOwnerSettings')
    expect(actionsSection).toContain(
      'const sourceRuntimeSettings = getTaskSourceRuntimeSettings(sourceContext)'
    )
    expect(actionsSection).toContain('sourceRuntimeSettings.activeRuntimeEnvironmentId')
    expect(actionsSection).toContain('...sourceRuntimeSettings')
    expect(actionsSection).toContain('getActiveRuntimeTarget(sourceSettings)')
    expect(actionsSection).toContain(
      "const canMergeWithRepoContext = (!!repoPath || mergeTarget.kind === 'environment') && !readOnly"
    )
    expect(actionsSection).toContain("'github.mergePR'")
    expect(actionsSection).toContain("'github.setPRAutoMerge'")
    expect(actionsSection).toContain(
      'repo: getGitHubRuntimeRepoId(sourceContext, repoId ?? item.repoId)'
    )
    expect(actionsSection).toContain('sourceContext,')
    expect(actionsSection).toContain('notifyWorkItemDetailsMutation(')
    expect(actionsSection).toContain('{ local: false }')
  })

  it('routes check actions through the task source context', () => {
    const source = componentSource('GitHubItemDialog.tsx')
    const checksSection = sourceBetween(
      source,
      'function ChecksTab',
      'function getGitHubMutationSettings'
    )

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
  })
})

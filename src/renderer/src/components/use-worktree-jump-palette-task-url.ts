import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import {
  getComposerEligibleRepos,
  resolveComposerActiveRepoId
} from '@/lib/new-workspace-composer-repo'
import { resolveWorkspaceCreationTarget } from '@/lib/project-host-workspace-target'
import { lookupCmdJGitHubUrlWorkItem } from '@/lib/cmd-j-github-url-lookup'
import { lookupLinearIssueUrl } from '@/lib/linear-issue-url-lookup'
import {
  withResolvedCmdJGitHubPreview,
  type CmdJTaskSourceUrl,
  getCmdJTaskUrlCreatePreview
} from '@/lib/worktree-palette-task-url-match'
import type { GitHubWorkItem } from '../../../shared/github/work-item-types'
import type { LinearIssue } from '../../../shared/linear/issue-types'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import { buildTaskSourceContextFromRepo } from '../../../shared/task-source-context'
import type { WorktreePaletteRequestGuard } from '@/lib/worktree-palette-create-action'

export type CmdJLinearIssuePreview = {
  query: string
  issue: LinearIssue | null
  loading: boolean
  initialRepoId: string | null
  sourceContext: TaskSourceContext | null
}

export type CmdJGitHubWorkItemPreview = {
  query: string
  item: GitHubWorkItem | null
  loading: boolean
  initialRepoId: string | null
  sourceContext: TaskSourceContext | null
}

function getComposerDefaultWorkspaceTarget(state: ReturnType<typeof useAppStore.getState>) {
  const eligibleRepos = getComposerEligibleRepos(state.repos)
  const activeRepoId = resolveComposerActiveRepoId(state.repos, eligibleRepos, state.activeRepoId)
  const resolution = resolveWorkspaceCreationTarget({
    eligibleRepos,
    projects: state.projects,
    projectHostSetups: state.projectHostSetups,
    activeRepoId,
    focusedHostScope: state.workspaceHostScope
  })
  return resolution.status === 'ready' ? resolution.target : null
}

export function useWorktreeJumpPaletteTaskUrl({
  visible,
  createWorktreeName,
  taskSourceUrl,
  createLookupGuard
}: {
  visible: boolean
  createWorktreeName: string
  taskSourceUrl: CmdJTaskSourceUrl | null
  createLookupGuard: WorktreePaletteRequestGuard
}) {
  const linearIssueUrlIntent = taskSourceUrl?.provider === 'linear' ? taskSourceUrl.intent : null
  const githubUrlLink = taskSourceUrl?.provider === 'github' ? taskSourceUrl.link : null
  const parsedTaskUrlCreatePreview = useMemo(
    () => (taskSourceUrl ? getCmdJTaskUrlCreatePreview(taskSourceUrl) : null),
    [taskSourceUrl]
  )
  const [linearIssuePreview, setLinearIssuePreview] = useState<CmdJLinearIssuePreview | null>(null)
  const [githubWorkItemPreview, setGithubWorkItemPreview] =
    useState<CmdJGitHubWorkItemPreview | null>(null)
  const linearLookupRef = useRef<{
    query: string
    promise: Promise<CmdJLinearIssuePreview>
  } | null>(null)
  const githubLookupRef = useRef<{
    query: string
    promise: Promise<CmdJGitHubWorkItemPreview>
  } | null>(null)
  const linearGenerationRef = useRef(0)
  const githubGenerationRef = useRef(0)

  useLayoutEffect(() => {
    const generation = ++linearGenerationRef.current
    linearLookupRef.current = null
    if (!visible || !linearIssueUrlIntent) {
      setLinearIssuePreview(null)
      return
    }
    const state = useAppStore.getState()
    const target = getComposerDefaultWorkspaceTarget(state)
    const sourceContext = target
      ? buildTaskSourceContextFromRepo({
          provider: 'linear',
          projectId: target.projectId,
          repo: target.repo,
          projectHostSetupId: target.projectHostSetupId
        })
      : null
    const pending: CmdJLinearIssuePreview = {
      query: createWorktreeName,
      issue: null,
      loading: true,
      initialRepoId: target?.repoId ?? null,
      sourceContext
    }
    setLinearIssuePreview(pending)
    const promise = lookupLinearIssueUrl({
      intent: linearIssueUrlIntent,
      knownStatus: state.linearStatus,
      sourceContext,
      fetchLinearIssue: state.fetchLinearIssue
    })
      .catch(() => null)
      .then((issue): CmdJLinearIssuePreview => ({ ...pending, issue, loading: false }))
    linearLookupRef.current = { query: createWorktreeName, promise }
    void promise.then((preview) => {
      if (linearGenerationRef.current === generation) {
        setLinearIssuePreview(preview)
      }
    })
    return () => {
      if (linearGenerationRef.current === generation) {
        linearGenerationRef.current += 1
      }
    }
  }, [createWorktreeName, linearIssueUrlIntent, visible])

  useLayoutEffect(() => {
    const generation = ++githubGenerationRef.current
    githubLookupRef.current = null
    if (!visible || !githubUrlLink) {
      setGithubWorkItemPreview(null)
      return
    }
    const state = useAppStore.getState()
    const target = getComposerDefaultWorkspaceTarget(state)
    const sourceContext = target
      ? buildTaskSourceContextFromRepo({
          provider: 'github',
          projectId: target.projectId,
          repo: target.repo,
          projectHostSetupId: target.projectHostSetupId
        })
      : null
    const pending: CmdJGitHubWorkItemPreview = {
      query: createWorktreeName,
      item: null,
      loading: true,
      initialRepoId: target?.repoId ?? null,
      sourceContext
    }
    setGithubWorkItemPreview(pending)
    const promise = lookupCmdJGitHubUrlWorkItem({
      link: githubUrlLink,
      repo: target?.repo ?? null,
      sourceContext
    })
      .catch(() => null)
      .then((item): CmdJGitHubWorkItemPreview => ({ ...pending, item, loading: false }))
    githubLookupRef.current = { query: createWorktreeName, promise }
    void promise.then((preview) => {
      if (githubGenerationRef.current === generation) {
        setGithubWorkItemPreview(preview)
      }
    })
    return () => {
      if (githubGenerationRef.current === generation) {
        githubGenerationRef.current += 1
      }
    }
  }, [createWorktreeName, githubUrlLink, visible])

  const currentLinearIssuePreview =
    linearIssuePreview?.query === createWorktreeName ? linearIssuePreview : null
  const currentGitHubWorkItemPreview =
    githubWorkItemPreview?.query === createWorktreeName ? githubWorkItemPreview : null
  const taskUrlCreatePreview = useMemo(() => {
    if (!parsedTaskUrlCreatePreview) {
      return null
    }
    return withResolvedCmdJGitHubPreview(
      parsedTaskUrlCreatePreview,
      currentGitHubWorkItemPreview?.item?.title ?? null,
      currentGitHubWorkItemPreview?.loading === true
    )
  }, [currentGitHubWorkItemPreview, parsedTaskUrlCreatePreview])
  const [linearLoadingFeedbackQuery, setLinearLoadingFeedbackQuery] = useState<string | null>(null)
  useEffect(() => {
    if (!currentLinearIssuePreview?.loading) {
      setLinearLoadingFeedbackQuery(null)
      return
    }
    setLinearLoadingFeedbackQuery(null)
    const timer = window.setTimeout(
      () => setLinearLoadingFeedbackQuery(currentLinearIssuePreview.query),
      200
    )
    return () => window.clearTimeout(timer)
  }, [currentLinearIssuePreview?.loading, currentLinearIssuePreview?.query])

  return {
    linearIssueUrlIntent,
    githubUrlLink,
    taskUrlCreatePreview,
    currentLinearIssuePreview,
    currentGitHubWorkItemPreview,
    linearLookupRef,
    githubLookupRef,
    showLinearLoadingFeedback:
      currentLinearIssuePreview?.loading === true &&
      linearLoadingFeedbackQuery === currentLinearIssuePreview.query,
    createLookupGuard
  }
}

export type WorktreeJumpPaletteTaskUrl = ReturnType<typeof useWorktreeJumpPaletteTaskUrl>

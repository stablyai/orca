/* eslint-disable max-lines -- Why: owns source tabs, search orchestration, and result rendering as one create-flow form control. */
/* oxlint-disable react-doctor/no-adjust-state-on-prop-change -- Why: this component's existing reset effects need a dedicated refactor outside the Linear API compatibility change. */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  CaseSensitive,
  CircleDot,
  ExternalLink,
  GitBranch,
  GitBranchPlus,
  GitMerge,
  GitPullRequest,
  LoaderCircle,
  Search,
  X
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { Command, CommandGroup, CommandItem, CommandList } from '@/components/ui/command'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import {
  normalizeGitHubLinkQuery,
  parseGitHubIssueOrPRLink,
  type RepoSlug
} from '@/lib/github-links'
import {
  lookupGitHubWorkItemByOwnerRepoForSource,
  lookupGitHubWorkItemForSource
} from '@/lib/github-work-item-source-lookup'
import { lookupSmartGitHubSubmitItem } from '@/lib/smart-github-submit'
import {
  listGitLabMRsForSource,
  lookupGitLabWorkItemByPathForSource
} from '@/lib/gitlab-work-item-source-lookup'
import { parseGitLabIssueOrMRLink } from '@/lib/gitlab-links'
import { isImeCompositionKeyDown } from '@/lib/ime-composition-keyboard-event'
import { getLocalPreflightContext, localPreflightContextKey } from '@/lib/local-preflight-context'
import { getRepoOwnerRoutedSettings } from '@/lib/repo-runtime-owner'
import { cn } from '@/lib/utils'
import { LinearIcon } from '@/components/icons/LinearIcon'
import { JiraIcon } from '@/components/icons/JiraIcon'
import { searchRuntimeRepoBaseRefDetails } from '@/runtime/runtime-repo-client'
import {
  buildSmartWorkspaceSourceRows,
  getBranchSearchRequest,
  getSmartWorkspaceEmptyHint,
  getVisibleBranchResults,
  isSmartWorkspaceSourceQueryWithinLimit,
  type SmartNameMode,
  type SmartWorkspaceSourceRow
} from './smart-workspace-source-results'
import { filterAvailableTaskProviders } from '../../../../shared/task-providers'
import type {
  BaseRefSearchResult,
  GitHubWorkItem,
  GitLabWorkItem,
  LinearIssue
} from '../../../../shared/types'
import { resolveSmartWorkspaceCommandValue } from './smart-workspace-command-value'
import { isComposerFieldToFieldFocus } from './smart-workspace-source-popover-focus'
import { translate } from '@/i18n/i18n'
import {
  getMrStateFilters,
  getSmartWorkspaceNameModes,
  type MrStateFilter
} from './smart-workspace-localized-options'
import {
  buildTaskSourceContextFromRepo,
  getTaskSourceCacheScope,
  type TaskSourceContext
} from '../../../../shared/task-source-context'
import { parseExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import { githubRepoIdentityKey } from '../../../../shared/github-repository-identity-key'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import {
  getGitHubRuntimeRepoId,
  getGitHubSourceRuntimeTarget
} from '@/lib/github-source-runtime-context'

type RepoOption = ReturnType<typeof useAppStore.getState>['repos'][number]
const EMPTY_REPO_SEARCH_REPOS: readonly RepoOption[] = []

type SmartWorkspaceNameFieldProps = {
  repos: RepoOption[]
  repoId: string
  onRepoChange: (repoId: string) => void
  value: string
  onValueChange: (value: string) => void
  onGitHubItemSelect: (item: GitHubWorkItem) => void
  /** Optional; when omitted, GitLab paste-URL detection is silently skipped. */
  onGitLabItemSelect?: (item: GitLabWorkItem) => void
  onBranchSelect: (refName: string, localBranchName: string) => void
  onLinearIssueSelect: (issue: LinearIssue) => void
  selectedSource: SmartWorkspaceNameSelection | null
  onClearSelectedSource: () => void
  githubSourceContext?: TaskSourceContext | null
  inputRef?: React.RefObject<HTMLInputElement | null>
  onPlainEnter?: () => void
  disabled?: boolean
  disabledPlaceholder?: string
  textOnly?: boolean
  branchesEnabled?: boolean
  repoBackedSourcesDisabled?: boolean
  repoBackedSearchRepos?: readonly RepoOption[]
  allowCrossRepoProjectAdd?: boolean
  crossRepoSwitchTarget?: 'project' | 'task-source'
  onActiveSourceModeChange?: (mode: SmartNameMode) => void
}

export type SmartWorkspaceNameSelection = {
  kind: 'github-pr' | 'github-issue' | 'gitlab-mr' | 'gitlab-issue' | 'branch' | 'linear' | 'jira'
  label: string
  url?: string
}

const SEARCH_DEBOUNCE_MS = 200
const RESULT_LIMIT = 12

export function canUseGitLabSmartSource({
  localGitlabAvailable,
  repoBackedSourcesDisabled,
  sourceHostId
}: {
  localGitlabAvailable: boolean
  repoBackedSourcesDisabled: boolean
  sourceHostId: ExecutionHostId | null | undefined
}): boolean {
  if (repoBackedSourcesDisabled) {
    return false
  }
  const parsedHost = parseExecutionHostId(sourceHostId)
  return parsedHost?.kind === 'ssh' || parsedHost?.kind === 'runtime' || localGitlabAvailable
}

type RowEntry = SmartWorkspaceSourceRow

const ROW_ITEM_CLASS_NAME = 'gap-2 px-3 py-2 text-xs'

function isTypedTextSourceRow(row: RowEntry): boolean {
  return row.kind === 'use-name' || row.kind === 'create-branch'
}

function getRowItemClassName(row: RowEntry, options?: { pinnedAction?: boolean }): string {
  return cn(
    ROW_ITEM_CLASS_NAME,
    options?.pinnedAction && isTypedTextSourceRow(row) && 'bg-muted/35'
  )
}

export default function SmartWorkspaceNameField({
  repos,
  repoId,
  onRepoChange,
  value,
  onValueChange,
  onGitHubItemSelect,
  onGitLabItemSelect,
  onBranchSelect,
  onLinearIssueSelect,
  selectedSource,
  onClearSelectedSource,
  githubSourceContext: githubSourceContextOverride,
  inputRef,
  onPlainEnter,
  disabled = false,
  disabledPlaceholder,
  textOnly = false,
  branchesEnabled = true,
  repoBackedSourcesDisabled = false,
  repoBackedSearchRepos = EMPTY_REPO_SEARCH_REPOS,
  allowCrossRepoProjectAdd = true,
  crossRepoSwitchTarget = 'project',
  onActiveSourceModeChange
}: SmartWorkspaceNameFieldProps): React.JSX.Element {
  // Why: subscribe so translate()-based tab/filter labels refresh on language change without a remount.
  useTranslation()
  const {
    addRepo,
    checkLinearConnection,
    fetchWorkItems,
    fetchWorkItemsAcrossRepos,
    getCachedWorkItems,
    linearStatus,
    linearStatusChecked,
    listLinearIssues,
    preflightStatus,
    preflightStatusChecked,
    preflightStatusContextKey,
    expectedPreflightContextKey,
    refreshPreflightStatus,
    searchLinearIssues,
    settings
  } = useAppStore(
    useShallow((s) => ({
      addRepo: s.addRepo,
      checkLinearConnection: s.checkLinearConnection,
      fetchWorkItems: s.fetchWorkItems,
      fetchWorkItemsAcrossRepos: s.fetchWorkItemsAcrossRepos,
      getCachedWorkItems: s.getCachedWorkItems,
      linearStatus: s.linearStatus,
      linearStatusChecked: s.linearStatusChecked,
      listLinearIssues: s.listLinearIssues,
      preflightStatus: s.preflightStatus,
      preflightStatusChecked: s.preflightStatusChecked,
      preflightStatusContextKey: s.preflightStatusContextKey,
      expectedPreflightContextKey: localPreflightContextKey(getLocalPreflightContext(s)),
      refreshPreflightStatus: s.refreshPreflightStatus,
      searchLinearIssues: s.searchLinearIssues,
      settings: s.settings
    }))
  )
  const selectedRepo = useMemo(
    () => repos.find((repo) => repo.id === repoId) ?? null,
    [repoId, repos]
  )
  const selectedRepoOwnerSettings = useMemo(
    () => getRepoOwnerRoutedSettings(settings, selectedRepo),
    [selectedRepo, settings]
  )
  const githubSourceContext = useMemo(() => {
    if (githubSourceContextOverride?.provider === 'github') {
      return githubSourceContextOverride
    }
    return selectedRepo
      ? buildTaskSourceContextFromRepo({
          provider: 'github',
          projectId: selectedRepo.id,
          repo: selectedRepo
        })
      : null
  }, [githubSourceContextOverride, selectedRepo])
  const gitlabSourceContext = useMemo(
    () =>
      selectedRepo
        ? buildTaskSourceContextFromRepo({
            provider: 'gitlab',
            projectId: selectedRepo.id,
            repo: selectedRepo
          })
        : null,
    [selectedRepo]
  )
  const repoBackedSearchTargets = useMemo(
    () =>
      (repoBackedSearchRepos.length > 0
        ? repoBackedSearchRepos
        : selectedRepo
          ? [selectedRepo]
          : []
      ).map((repo) => ({
        repo,
        githubSourceContext:
          repo.id === selectedRepo?.id && githubSourceContext?.provider === 'github'
            ? githubSourceContext
            : buildTaskSourceContextFromRepo({
                provider: 'github',
                projectId: repo.id,
                repo
              }),
        gitlabSourceContext:
          repo.id === selectedRepo?.id && gitlabSourceContext?.provider === 'gitlab'
            ? gitlabSourceContext
            : buildTaskSourceContextFromRepo({
                provider: 'gitlab',
                projectId: repo.id,
                repo
              })
      })),
    [githubSourceContext, gitlabSourceContext, repoBackedSearchRepos, selectedRepo]
  )
  const linearSourceContext = useMemo(
    () =>
      selectedRepo
        ? buildTaskSourceContextFromRepo({
            provider: 'linear',
            projectId: selectedRepo.id,
            repo: selectedRepo
          })
        : null,
    [selectedRepo]
  )
  const [mode, setMode] = useState<SmartNameMode>(textOnly ? 'text' : 'smart')
  const [mrStateFilter, setMrStateFilter] = useState<MrStateFilter>('opened')
  const [open, setOpen] = useState(false)
  const [debouncedQuery, setDebouncedQuery] = useState(value)
  const [githubItems, setGithubItems] = useState<GitHubWorkItem[]>([])
  const [gitlabItems, setGitlabItems] = useState<GitLabWorkItem[]>([])
  const [branches, setBranches] = useState<BaseRefSearchResult[]>([])
  const [branchResultsSource, setBranchResultsSource] = useState<{
    repoId: string
    query: string
  } | null>(null)
  const [linearIssues, setLinearIssues] = useState<LinearIssue[]>([])
  const [githubLoading, setGithubLoading] = useState(false)
  const [gitlabLoading, setGitlabLoading] = useState(false)
  const [branchesLoading, setBranchesLoading] = useState(false)
  const [linearLoading, setLinearLoading] = useState(false)
  const [commandValue, setCommandValue] = useState('')
  const localInputRef = useRef<HTMLInputElement | null>(null)
  const focusedSelectedSourceKeyRef = useRef<string | null>(null)
  const tabsListRef = useRef<HTMLDivElement | null>(null)
  const repoSlugCacheRef = useRef<Map<string, RepoSlug>>(new Map())
  const handledCrossRepoUrlRef = useRef<string | null>(null)
  const localInputFocusFrameRef = useRef<number | null>(null)
  // Why: Electron makes programmatic .focus() look user-initiated, so gate the source popover until real interaction.
  const deferSourcePopoverUntilInteractionRef = useRef(true)
  const [crossRepoPrompt, setCrossRepoPrompt] = useState<{
    link: NonNullable<ReturnType<typeof parseGitHubIssueOrPRLink>>
    matchingRepo: RepoOption | null
  } | null>(null)

  useEffect(() => {
    onActiveSourceModeChange?.(mode)
  }, [mode, onActiveSourceModeChange])
  const preflightStatusCurrent = preflightStatusContextKey === expectedPreflightContextKey
  const localGitlabAvailable = preflightStatusCurrent && preflightStatus?.glab?.installed === true
  const gitlabSourceAvailable = repoBackedSearchTargets.some((target) =>
    canUseGitLabSmartSource({
      localGitlabAvailable,
      repoBackedSourcesDisabled,
      sourceHostId: target.gitlabSourceContext?.hostId
    })
  )
  const availableTaskProviders = useMemo(
    () =>
      filterAvailableTaskProviders(['github', 'gitlab', 'linear'], {
        gitlabInstalled: gitlabSourceAvailable,
        linearConnected: linearStatus.connected === true
      }),
    [gitlabSourceAvailable, linearStatus.connected]
  )
  const linearAvailable = availableTaskProviders.includes('linear')
  const availableModes = getSmartWorkspaceNameModes().filter((item) => {
    if (textOnly) {
      return item.id === 'text'
    }
    if (item.id === 'github') {
      return !repoBackedSourcesDisabled
    }
    if (item.id === 'gitlab') {
      return gitlabSourceAvailable
    }
    if (item.id === 'linear') {
      return linearAvailable
    }
    if (item.id === 'branches') {
      return branchesEnabled && !repoBackedSourcesDisabled
    }
    return true
  })
  const mrStateFilters = getMrStateFilters()

  useEffect(() => {
    if (availableModes.some((item) => item.id === mode)) {
      return
    }
    setMode(availableModes[0]?.id ?? 'text')
  }, [availableModes, mode])

  useEffect(() => {
    if (!repoBackedSourcesDisabled) {
      return
    }
    setGithubItems([])
    setGitlabItems([])
    setBranches([])
    setGithubLoading(false)
    setGitlabLoading(false)
    setBranchesLoading(false)
    setBranchResultsSource(null)
    setCrossRepoPrompt(null)
  }, [repoBackedSourcesDisabled])

  const selectedSourceFocusKey = selectedSource
    ? `${selectedSource.kind}:${selectedSource.label}:${selectedSource.url ?? ''}`
    : null
  const setSelectedSourceNode = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node) {
        focusedSelectedSourceKeyRef.current = null
        return
      }
      if (
        !selectedSourceFocusKey ||
        focusedSelectedSourceKeyRef.current === selectedSourceFocusKey
      ) {
        return
      }
      focusedSelectedSourceKeyRef.current = selectedSourceFocusKey
      // Why: input unmounts after Enter accepts a row; move focus to the pill so the next Enter advances to Agent.
      node.focus({ preventScroll: true })
    },
    [selectedSourceFocusKey]
  )

  const cancelLocalInputFocusFrame = useCallback((): void => {
    if (localInputFocusFrameRef.current === null) {
      return
    }
    cancelAnimationFrame(localInputFocusFrameRef.current)
    localInputFocusFrameRef.current = null
  }, [])

  const markSourcePopoverUserEngaged = useCallback((): void => {
    deferSourcePopoverUntilInteractionRef.current = false
  }, [])

  const tryOpenSourcePopover = useCallback((): void => {
    if (disabled || mode === 'text' || deferSourcePopoverUntilInteractionRef.current) {
      return
    }
    setOpen(true)
  }, [disabled, mode])

  const handleSourcePopoverOpenChange = useCallback(
    (next: boolean): void => {
      if (disabled || selectedSource) {
        setOpen(false)
        return
      }
      if (next && deferSourcePopoverUntilInteractionRef.current) {
        return
      }
      setOpen(next)
    },
    [disabled, selectedSource]
  )

  const setInputNode = useCallback(
    (node: HTMLInputElement | null) => {
      if (node === null) {
        cancelLocalInputFocusFrame()
      }
      localInputRef.current = node
      if (inputRef) {
        inputRef.current = node
      }
    },
    [cancelLocalInputFocusFrame, inputRef]
  )

  useEffect(() => {
    if (disabled || textOnly) {
      return
    }
    if (!preflightStatusChecked || !preflightStatusCurrent) {
      void refreshPreflightStatus()
    }
    if (!linearStatusChecked) {
      void checkLinearConnection()
    }
  }, [
    checkLinearConnection,
    disabled,
    linearStatusChecked,
    preflightStatusChecked,
    preflightStatusCurrent,
    refreshPreflightStatus,
    textOnly
  ])

  useEffect(() => {
    if (textOnly) {
      if (mode !== 'text') {
        setMode('text')
      }
      setOpen(false)
      return
    }
    if ((mode === 'gitlab' && gitlabSourceAvailable) || (mode === 'linear' && linearAvailable)) {
      return
    }
    if (mode !== 'gitlab' && mode !== 'linear') {
      return
    }
    setMode('smart')
    setGitlabItems([])
    setLinearIssues([])
    setGitlabLoading(false)
    setLinearLoading(false)
    setCommandValue('')
  }, [gitlabSourceAvailable, linearAvailable, mode, textOnly])

  useEffect(() => {
    if (!disabled) {
      return
    }
    setOpen(false)
    setGithubItems([])
    setGitlabItems([])
    setBranches([])
    setBranchResultsSource(null)
    setLinearIssues([])
    setGithubLoading(false)
    setGitlabLoading(false)
    setBranchesLoading(false)
    setLinearLoading(false)
    setCommandValue('')
    setCrossRepoPrompt(null)
  }, [disabled])

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(value), SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [value])

  const sourceQueryWithinLimit = useMemo(
    () => isSmartWorkspaceSourceQueryWithinLimit(debouncedQuery),
    [debouncedQuery]
  )
  const normalizedGhQuery = useMemo(
    () => normalizeGitHubLinkQuery(sourceQueryWithinLimit ? debouncedQuery : ''),
    [debouncedQuery, sourceQueryWithinLimit]
  )
  const parsedGhLink = useMemo(
    () => (sourceQueryWithinLimit ? parseGitHubIssueOrPRLink(debouncedQuery) : null),
    [debouncedQuery, sourceQueryWithinLimit]
  )
  const shouldQueryGithub =
    sourceQueryWithinLimit &&
    !repoBackedSourcesDisabled &&
    !textOnly &&
    repoBackedSearchTargets.length > 0 &&
    (mode === 'smart' || mode === 'github')
  const shouldQueryLinear =
    sourceQueryWithinLimit &&
    !textOnly &&
    linearAvailable &&
    (mode === 'smart' || mode === 'linear')

  useEffect(() => {
    if (disabled || !shouldQueryGithub) {
      setGithubItems([])
      setGithubLoading(false)
      return
    }
    let stale = false
    const directNumber = normalizedGhQuery.directNumber
    const directLink = parsedGhLink
    if (directLink !== null && handledCrossRepoUrlRef.current !== debouncedQuery.trim()) {
      setGithubLoading(true)
      const directLookup = async (): Promise<{
        items: GitHubWorkItem[]
        prompt: {
          link: NonNullable<ReturnType<typeof parseGitHubIssueOrPRLink>>
          matchingRepo: RepoOption | null
        } | null
      }> => {
        if (crossRepoSwitchTarget === 'task-source') {
          const matchingTarget = await findMatchingRepoForSlug(
            repoBackedSearchTargets.map((target) => ({
              repo: target.repo,
              sourceContext: target.githubSourceContext
            })),
            directLink.slug,
            repoSlugCacheRef.current
          )
          if (!matchingTarget) {
            return { items: [], prompt: null }
          }
          const item = await lookupGitHubWorkItemByOwnerRepoForSource({
            repoPath: matchingTarget.repo.path,
            repoId: matchingTarget.repo.id,
            sourceContext: matchingTarget.sourceContext,
            owner: directLink.slug.owner,
            repo: directLink.slug.repo,
            ...(directLink.slug.host ? { host: directLink.slug.host } : {}),
            number: directLink.number,
            type: directLink.type
          })
          // Why: only suppress re-tries once resolution succeeded — a transient
          // GHES slug failure (matchingTarget === null) must stay retryable.
          handledCrossRepoUrlRef.current = debouncedQuery.trim()
          return {
            items: item ? [{ ...item, repoId: matchingTarget.repo.id } as GitHubWorkItem] : [],
            prompt: null
          }
        }
        if (!selectedRepo?.path) {
          return { items: [], prompt: null }
        }
        const selectedSlug = await getRepoSlugCached(
          selectedRepo,
          githubSourceContext,
          repoSlugCacheRef.current
        )
        if (!selectedSlug || sameSlug(selectedSlug, directLink.slug)) {
          handledCrossRepoUrlRef.current = debouncedQuery.trim()
          const item = await lookupSmartGitHubSubmitItem({
            repoPath: selectedRepo.path,
            repoId: selectedRepo.id,
            sourceContext: githubSourceContext,
            intent: {
              kind: 'link',
              owner: directLink.slug.owner,
              repo: directLink.slug.repo,
              ...(directLink.slug.host ? { host: directLink.slug.host } : {}),
              number: directLink.number,
              type: directLink.type
            },
            workItem: lookupGitHubWorkItemForSource,
            workItemByOwnerRepo: lookupGitHubWorkItemByOwnerRepoForSource
          })
          return { items: item ? [item] : [], prompt: null }
        }
        const matchingTarget = await findMatchingRepoForSlug(
          repos.map((repo) => ({
            repo,
            sourceContext: buildTaskSourceContextFromRepo({
              provider: 'github',
              projectId: repo.id,
              repo
            })
          })),
          directLink.slug,
          repoSlugCacheRef.current
        )
        return {
          items: [],
          prompt: { link: directLink, matchingRepo: matchingTarget?.repo ?? null }
        }
      }
      void directLookup()
        .then((result) => {
          if (stale) {
            return
          }
          setGithubItems(result.items)
          if (result.prompt) {
            setOpen(false)
            setCrossRepoPrompt(result.prompt)
          }
        })
        .catch(() => {
          if (!stale) {
            setGithubItems([])
          }
        })
        .finally(() => {
          if (!stale) {
            setGithubLoading(false)
          }
        })
      return () => {
        stale = true
      }
    }
    if (directNumber !== null) {
      setGithubLoading(true)
      const intent =
        directLink !== null
          ? {
              kind: 'link' as const,
              owner: directLink.slug.owner,
              repo: directLink.slug.repo,
              ...(directLink.slug.host ? { host: directLink.slug.host } : {}),
              number: directLink.number,
              type: directLink.type
            }
          : { kind: 'hash-number' as const, number: directNumber }
      const request = Promise.all(
        repoBackedSearchTargets.map((target) =>
          lookupSmartGitHubSubmitItem({
            repoPath: target.repo.path,
            repoId: target.repo.id,
            sourceContext: target.githubSourceContext,
            intent,
            workItem: lookupGitHubWorkItemForSource,
            workItemByOwnerRepo: lookupGitHubWorkItemByOwnerRepoForSource
          }).catch(() => null)
        )
      ).then((items) =>
        items
          .filter((item): item is GitHubWorkItem => item !== null)
          .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
          .slice(0, RESULT_LIMIT)
      )
      void request
        .then((items) => {
          if (!stale) {
            setGithubItems(items)
          }
        })
        .catch(() => {
          if (!stale) {
            setGithubItems([])
          }
        })
        .finally(() => {
          if (!stale) {
            setGithubLoading(false)
          }
        })
      return () => {
        stale = true
      }
    }

    const trimmed = normalizedGhQuery.query.trim()
    const query = trimmed ? normalizedGhQuery.query : ''
    if (repoBackedSearchTargets.length === 1) {
      const target = repoBackedSearchTargets[0]
      const cached = getCachedWorkItems(
        target.repo.id,
        RESULT_LIMIT,
        query,
        target.repo.path,
        target.githubSourceContext
      )
      if (cached) {
        setGithubItems(cached.slice(0, RESULT_LIMIT))
        setGithubLoading(false)
      } else {
        setGithubLoading(true)
      }
      void fetchWorkItems(target.repo.id, target.repo.path, RESULT_LIMIT, query, {
        sourceContext: target.githubSourceContext
      })
        .then((items) => {
          if (!stale) {
            setGithubItems(items.slice(0, RESULT_LIMIT))
          }
        })
        .catch(() => {
          if (!stale) {
            setGithubItems([])
          }
        })
        .finally(() => {
          if (!stale) {
            setGithubLoading(false)
          }
        })
    } else {
      setGithubLoading(true)
      void fetchWorkItemsAcrossRepos(
        repoBackedSearchTargets.map((target) => ({
          repoId: target.repo.id,
          path: target.repo.path,
          executionHostId: target.repo.executionHostId,
          sourceContext: target.githubSourceContext
        })),
        RESULT_LIMIT,
        RESULT_LIMIT,
        query
      )
        .then((result) => {
          if (!stale) {
            setGithubItems(result.items)
          }
        })
        .catch(() => {
          if (!stale) {
            setGithubItems([])
          }
        })
        .finally(() => {
          if (!stale) {
            setGithubLoading(false)
          }
        })
    }
    return () => {
      stale = true
    }
  }, [
    debouncedQuery,
    disabled,
    fetchWorkItems,
    fetchWorkItemsAcrossRepos,
    getCachedWorkItems,
    normalizedGhQuery,
    parsedGhLink,
    repos,
    repoBackedSearchTargets,
    githubSourceContext,
    selectedRepo,
    crossRepoSwitchTarget,
    shouldQueryGithub
  ])

  const branchSearchRequest = useMemo(
    () =>
      getBranchSearchRequest({
        disabled,
        branchesEnabled: branchesEnabled && !repoBackedSourcesDisabled,
        textOnly,
        mode,
        selectedRepoId: selectedRepo?.id ?? null,
        query: debouncedQuery,
        limit: RESULT_LIMIT
      }),
    [
      branchesEnabled,
      debouncedQuery,
      disabled,
      mode,
      repoBackedSourcesDisabled,
      selectedRepo?.id,
      textOnly
    ]
  )

  useEffect(() => {
    if (!branchSearchRequest) {
      setBranches([])
      setBranchResultsSource(null)
      setBranchesLoading(false)
      return
    }
    let stale = false
    setBranches([])
    setBranchResultsSource(null)
    setBranchesLoading(true)
    void searchRuntimeRepoBaseRefDetails(
      selectedRepoOwnerSettings,
      branchSearchRequest.repoId,
      branchSearchRequest.query,
      branchSearchRequest.limit
    )
      .then((results) => {
        if (!stale) {
          setBranches(results)
          setBranchResultsSource({
            repoId: branchSearchRequest.repoId,
            query: branchSearchRequest.query
          })
        }
      })
      .catch(() => {
        if (!stale) {
          setBranches([])
          setBranchResultsSource(null)
        }
      })
      .finally(() => {
        if (!stale) {
          setBranchesLoading(false)
        }
      })
    return () => {
      stale = true
    }
  }, [branchSearchRequest, selectedRepoOwnerSettings])

  useEffect(() => {
    if (disabled || !shouldQueryLinear || !linearStatus.connected) {
      setLinearIssues([])
      setLinearLoading(false)
      return
    }
    let stale = false
    setLinearLoading(true)
    const trimmed = debouncedQuery.trim()
    const request = trimmed
      ? searchLinearIssues(trimmed, RESULT_LIMIT, { sourceContext: linearSourceContext })
      : listLinearIssues(
          { kind: 'list', filter: 'assigned', limit: RESULT_LIMIT },
          { sourceContext: linearSourceContext }
        ).then((result) => result.items)
    void request
      .then((issues) => {
        if (!stale) {
          setLinearIssues(issues)
        }
      })
      .catch(() => {
        if (!stale) {
          setLinearIssues([])
        }
      })
      .finally(() => {
        if (!stale) {
          setLinearLoading(false)
        }
      })
    return () => {
      stale = true
    }
    // Why: list/search are stable store methods; depending on them would refetch on unrelated store writes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQuery, disabled, linearSourceContext, linearStatus.connected, shouldQueryLinear])

  // Why: GitLab paste-URL flow; parseGitLabIssueOrMRLink filters non-GitLab URLs via the project-internal `/-/` separator.
  const parsedGlLink = useMemo(
    () => (sourceQueryWithinLimit ? parseGitLabIssueOrMRLink(debouncedQuery) : null),
    [debouncedQuery, sourceQueryWithinLimit]
  )
  const shouldQueryGitlab =
    sourceQueryWithinLimit &&
    !repoBackedSourcesDisabled &&
    !textOnly &&
    gitlabSourceAvailable &&
    repoBackedSearchTargets.length > 0 &&
    (mode === 'smart' || mode === 'gitlab')
  useEffect(() => {
    if (!shouldQueryGitlab || disabled || !onGitLabItemSelect) {
      // Why: don't clobber list-mode items — the listMRs effect below is the sole writer in 'gitlab' mode without a URL.
      if (!shouldQueryGitlab || (parsedGlLink === null && mode !== 'gitlab')) {
        setGitlabItems([])
      }
      setGitlabLoading(false)
      return
    }
    if (parsedGlLink === null) {
      // Same reason: only clear when leaving the gitlab/smart context.
      if (mode !== 'gitlab') {
        setGitlabItems([])
      }
      setGitlabLoading(false)
      return
    }
    let stale = false
    setGitlabLoading(true)
    void Promise.all(
      repoBackedSearchTargets.map((target) =>
        lookupGitLabWorkItemByPathForSource({
          repoPath: target.repo.path,
          repoId: target.repo.id,
          sourceContext: target.gitlabSourceContext,
          // Why: self-hosted GitLab URLs must resolve against their pasted hostname, not gitlab.com.
          host: parsedGlLink.slug.host,
          path: parsedGlLink.slug.path,
          iid: parsedGlLink.number,
          type: parsedGlLink.type
        }).catch(() => null)
      )
    )
      .then((items) => {
        if (stale) {
          return
        }
        setGitlabItems(items.filter((item): item is GitLabWorkItem => item !== null))
      })
      .catch(() => {
        if (!stale) {
          setGitlabItems([])
        }
      })
      .finally(() => {
        if (!stale) {
          setGitlabLoading(false)
        }
      })
    return () => {
      stale = true
    }
  }, [disabled, mode, onGitLabItemSelect, parsedGlLink, repoBackedSearchTargets, shouldQueryGitlab])

  // Why: list the project's MRs by state chip when no URL pasted; default 'opened' matches gitlab.com's default MR view.
  useEffect(() => {
    if (!shouldQueryGitlab || disabled || !onGitLabItemSelect) {
      if (!shouldQueryGitlab) {
        setGitlabItems([])
        setGitlabLoading(false)
      }
      return
    }
    if (repoBackedSearchTargets.length === 0) {
      setGitlabItems([])
      setGitlabLoading(false)
      return
    }
    if (parsedGlLink !== null) {
      // Why: paste-URL effect owns the list while a URL is in the input.
      return
    }
    let stale = false
    setGitlabLoading(true)
    // Why: thread the typed query so the GitLab API filters MRs by name/number (shouldQueryGitlab already gates oversized queries).
    const trimmedQuery = debouncedQuery.trim() || undefined
    void Promise.all(
      repoBackedSearchTargets.map((target) =>
        listGitLabMRsForSource({
          repoPath: target.repo.path,
          repoId: target.repo.id,
          sourceContext: target.gitlabSourceContext,
          state: mrStateFilter,
          page: 1,
          perPage: RESULT_LIMIT,
          query: trimmedQuery
        }).catch(() => ({ items: [], hasMore: false }))
      )
    )
      .then((results) => {
        if (stale) {
          return
        }
        setGitlabItems(
          results
            .flatMap((result) => result.items)
            .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
            .slice(0, RESULT_LIMIT)
        )
      })
      .catch(() => {
        if (!stale) {
          setGitlabItems([])
        }
      })
      .finally(() => {
        if (!stale) {
          setGitlabLoading(false)
        }
      })
    return () => {
      stale = true
    }
  }, [
    debouncedQuery,
    disabled,
    mode,
    mrStateFilter,
    onGitLabItemSelect,
    parsedGlLink,
    repoBackedSearchTargets,
    shouldQueryGitlab
  ])

  const rows = useMemo<RowEntry[]>(
    () =>
      buildSmartWorkspaceSourceRows({
        branches: getVisibleBranchResults({
          branches,
          mode,
          resultRepoId: branchResultsSource?.repoId ?? null,
          resultQuery: branchResultsSource?.query ?? null,
          selectedRepoId: selectedRepo?.id ?? null,
          value
        }),
        githubItems,
        gitlabAvailable: gitlabSourceAvailable,
        gitlabItems,
        linearAvailable,
        linearIssues,
        mode,
        resultLimit: RESULT_LIMIT,
        value
      }),
    [
      branches,
      branchResultsSource,
      githubItems,
      gitlabSourceAvailable,
      gitlabItems,
      linearAvailable,
      linearIssues,
      mode,
      selectedRepo?.id,
      value
    ]
  )
  const { typedTextActionRow, searchResultRows } = useMemo(() => {
    const typedTextRow = rows.find(isTypedTextSourceRow) ?? null
    return {
      typedTextActionRow: typedTextRow,
      searchResultRows: typedTextRow ? rows.filter((row) => row !== typedTextRow) : rows
    }
  }, [rows])

  // Why: source rows lag debouncedQuery, so keep Enter off a stale row.
  const valueWithinSourceLimit = isSmartWorkspaceSourceQueryWithinLimit(value)
  const debouncedQueryWithinSourceLimit = isSmartWorkspaceSourceQueryWithinLimit(debouncedQuery)
  const trimmedValue = valueWithinSourceLimit ? value.trim() : ''
  const trimmedDebouncedQuery = debouncedQueryWithinSourceLimit ? debouncedQuery.trim() : ''
  const isQueryStale = trimmedValue.length > 0 && trimmedDebouncedQuery !== trimmedValue

  // Why: when the typed value is an unambiguous source ref, snap the highlight to that row so Enter picks it over the typed-text fallback.
  const sourceIntent = useMemo<'github' | 'gitlab' | 'linear' | null>(() => {
    if (!isSmartWorkspaceSourceQueryWithinLimit(value)) {
      return null
    }
    const trimmed = value.trim()
    if (!trimmed) {
      return null
    }
    if (/^#\d+$/.test(trimmed) || parseGitHubIssueOrPRLink(trimmed) !== null) {
      return 'github'
    }
    if (parseGitLabIssueOrMRLink(trimmed) !== null) {
      return 'gitlab'
    }
    if (linearAvailable && /^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(trimmed)) {
      return 'linear'
    }
    return null
  }, [linearAvailable, value])

  const resolvedCommandValue = resolveSmartWorkspaceCommandValue({
    currentValue: commandValue,
    rows,
    isQueryStale,
    sourceIntent
  })

  const loading = githubLoading || gitlabLoading || branchesLoading || linearLoading
  const ActiveInputIcon = mode === 'text' ? CaseSensitive : loading ? LoaderCircle : Search

  const handleSelect = useCallback(
    (row: RowEntry) => {
      if (row.kind === 'use-name' || row.kind === 'create-branch') {
        // Why: "create new branch" has no ref to base from, so it uses the typed-name path (default base).
        onValueChange(row.name)
      } else if (row.kind === 'github') {
        onGitHubItemSelect(row.item)
      } else if (row.kind === 'gitlab') {
        // Why: optional handler — guarded so it no-ops for hosts without GitLab support.
        onGitLabItemSelect?.(row.item)
      } else if (row.kind === 'branch') {
        onBranchSelect(row.refName, row.localBranchName)
      } else {
        onLinearIssueSelect(row.issue)
      }
      setOpen(false)
    },
    [onBranchSelect, onGitHubItemSelect, onGitLabItemSelect, onLinearIssueSelect, onValueChange]
  )

  const acceptGitHubLink = useCallback(
    async (targetRepo: RepoOption): Promise<void> => {
      if (!crossRepoPrompt) {
        return
      }
      handledCrossRepoUrlRef.current = debouncedQuery.trim()
      setGithubLoading(true)
      try {
        const sourceContext = buildTaskSourceContextFromRepo({
          provider: 'github',
          projectId: targetRepo.id,
          repo: targetRepo
        })
        const item = await lookupGitHubWorkItemByOwnerRepoForSource({
          repoPath: targetRepo.path,
          repoId: targetRepo.id,
          sourceContext,
          owner: crossRepoPrompt.link.slug.owner,
          repo: crossRepoPrompt.link.slug.repo,
          ...(crossRepoPrompt.link.slug.host ? { host: crossRepoPrompt.link.slug.host } : {}),
          number: crossRepoPrompt.link.number,
          type: crossRepoPrompt.link.type
        })
        if (!item) {
          return
        }
        onRepoChange(targetRepo.id)
        onGitHubItemSelect({ ...item, repoId: targetRepo.id } as GitHubWorkItem)
        setOpen(false)
        setCrossRepoPrompt(null)
      } finally {
        setGithubLoading(false)
      }
    },
    [crossRepoPrompt, debouncedQuery, onGitHubItemSelect, onRepoChange]
  )

  const handleUseCurrentRepo = useCallback(async (): Promise<void> => {
    if (!selectedRepo) {
      return
    }
    setCrossRepoPrompt(null)
    await acceptGitHubLink(selectedRepo)
  }, [acceptGitHubLink, selectedRepo])

  const handleAddMatchingRepo = useCallback(async (): Promise<void> => {
    if (!crossRepoPrompt || !allowCrossRepoProjectAdd) {
      return
    }
    const added = await addRepo()
    if (!added) {
      return
    }
    const sourceContext = buildTaskSourceContextFromRepo({
      provider: 'github',
      projectId: added.id,
      repo: added
    })
    const slug = await getRepoSlugCached(added, sourceContext, repoSlugCacheRef.current)
    if (slug && sameSlug(slug, crossRepoPrompt.link.slug)) {
      await acceptGitHubLink(added)
    }
  }, [acceptGitHubLink, addRepo, allowCrossRepoProjectAdd, crossRepoPrompt])

  const dismissCrossRepoPrompt = useCallback((): void => {
    handledCrossRepoUrlRef.current = debouncedQuery.trim()
    setCrossRepoPrompt(null)
  }, [debouncedQuery])

  const smartPlaceholder = repoBackedSourcesDisabled
    ? linearAvailable
      ? translate(
          'auto.components.new.workspace.SmartWorkspaceNameField.placeholderNameOrLinearUrl',
          'Type a name or Linear URL'
        )
      : translate(
          'auto.components.new.workspace.SmartWorkspaceNameField.placeholderWorkspaceName',
          'Type a workspace name'
        )
    : linearAvailable
      ? branchesEnabled
        ? translate(
            'auto.components.new.workspace.SmartWorkspaceNameField.placeholderSmartWithBranchGitLabLinear',
            'Type a name, #1234, branch, GitHub/GitLab or Linear URL'
          )
        : translate(
            'auto.components.new.workspace.SmartWorkspaceNameField.placeholderSmartGitLabLinear',
            'Type a name, #1234, GitHub/GitLab or Linear URL'
          )
      : branchesEnabled
        ? translate(
            'auto.components.new.workspace.SmartWorkspaceNameField.placeholderSmartWithBranchGitLab',
            'Type a name, #1234, branch, GitHub or GitLab URL'
          )
        : translate(
            'auto.components.new.workspace.SmartWorkspaceNameField.placeholderSmartGitLab',
            'Type a name, #1234, GitHub or GitLab URL'
          )
  const crossRepoSwitchIsTaskSource = crossRepoSwitchTarget === 'task-source'
  const crossRepoSwitchTitle = crossRepoSwitchIsTaskSource
    ? translate(
        'auto.components.new.workspace.SmartWorkspaceNameField.switchTaskSourceTitle',
        'Switch task source?'
      )
    : translate(
        'auto.components.new.workspace.SmartWorkspaceNameField.4bd98f1091',
        'Switch project?'
      )
  const crossRepoSwitchDescriptionSuffix = crossRepoSwitchIsTaskSource
    ? translate(
        'auto.components.new.workspace.SmartWorkspaceNameField.differentTaskSource',
        ', which is different from the selected task source.'
      )
    : translate(
        'auto.components.new.workspace.SmartWorkspaceNameField.9ef1a7c4b0',
        ', which is different from the selected project.'
      )
  const crossRepoSwitchFallbackLabel = crossRepoSwitchIsTaskSource
    ? translate(
        'auto.components.new.workspace.SmartWorkspaceNameField.currentTaskSource',
        'current task source'
      )
    : translate(
        'auto.components.new.workspace.SmartWorkspaceNameField.fda67f0b61',
        'current project'
      )

  const placeholder = disabled
    ? (disabledPlaceholder ??
      translate('auto.components.new.workspace.SmartWorkspaceNameField.unavailable', 'Unavailable'))
    : mode === 'smart'
      ? smartPlaceholder
      : mode === 'github'
        ? translate(
            'auto.components.new.workspace.SmartWorkspaceNameField.searchGitHub',
            'Search GitHub PRs and issues'
          )
        : mode === 'gitlab'
          ? translate(
              'auto.components.new.workspace.SmartWorkspaceNameField.searchGitLab',
              'Search GitLab MRs and issues'
            )
          : mode === 'branches'
            ? translate(
                'auto.components.new.workspace.SmartWorkspaceNameField.searchBranches',
                'Search branches'
              )
            : mode === 'linear'
              ? translate(
                  'auto.components.new.workspace.SmartWorkspaceNameField.searchLinear',
                  'Search Linear issues'
                )
              : translate(
                  'auto.components.new.workspace.SmartWorkspaceNameField.workspaceName',
                  'Workspace name'
                )

  return (
    <div className="min-w-0 space-y-1.5">
      {textOnly ? null : (
        <div className="flex min-w-0 items-center gap-2 border-b border-border/40">
          <Tabs
            value={mode}
            onValueChange={(next) => {
              const nextMode = next as SmartNameMode
              onActiveSourceModeChange?.(nextMode)
              setMode(nextMode)
              if (!disabled && nextMode !== 'text' && selectedSource === null) {
                markSourcePopoverUserEngaged()
                setOpen(true)
              } else {
                setOpen(false)
              }
              cancelLocalInputFocusFrame()
              localInputFocusFrameRef.current = requestAnimationFrame(() => {
                localInputFocusFrameRef.current = null
                localInputRef.current?.focus({ preventScroll: true })
              })
            }}
            className="min-w-0 flex-1 gap-0"
          >
            <TabsList
              ref={tabsListRef}
              variant="line"
              className="h-7 w-full justify-start gap-4 px-0"
              onFocusCapture={(event) => {
                // Why: Radix Tabs roving focus re-applies tabindex=0 to the active trigger (races React commits), so forward Tab to the input.
                const previous = event.relatedTarget as HTMLElement | null
                const list = tabsListRef.current
                const input = localInputRef.current
                if (!list || !input) {
                  return
                }
                if (!previous || previous === input || list.contains(previous)) {
                  return
                }
                event.stopPropagation()
                input.focus({ preventScroll: true })
              }}
            >
              {availableModes.map(({ id, label, Icon }) => (
                <TabsTrigger
                  key={id}
                  value={id}
                  tabIndex={-1}
                  data-smart-name-mode={id}
                  className="flex-none gap-1.5 px-0 text-xs"
                >
                  <Icon className="size-3.5" />
                  <span>{label}</span>
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
      )}

      <Popover
        open={!disabled && open && mode !== 'text' && selectedSource === null}
        onOpenChange={handleSourcePopoverOpenChange}
      >
        <Command
          value={resolvedCommandValue}
          onValueChange={setCommandValue}
          shouldFilter={false}
          className="overflow-visible bg-transparent"
        >
          <PopoverAnchor asChild>
            <div className="relative min-w-0">
              {selectedSource ? (
                // Why: min-w-0 + w-full let the pill shrink; else the inner truncate's min-content (long PR title) widens the dialog past its max-w.
                <div
                  ref={setSelectedSourceNode}
                  data-workspace-source-pill="true"
                  tabIndex={0}
                  onKeyDown={(event) => {
                    if (
                      event.currentTarget !== event.target ||
                      event.key !== 'Enter' ||
                      event.metaKey ||
                      event.ctrlKey ||
                      event.shiftKey ||
                      event.altKey
                    ) {
                      return
                    }
                    event.preventDefault()
                    onPlainEnter?.()
                  }}
                  className="flex h-9 w-full min-w-0 items-center gap-2 rounded-md border border-input bg-background px-2.5 text-sm shadow-xs outline-none focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 dark:bg-input/30"
                >
                  <SelectionIcon kind={selectedSource.kind} />
                  <span className="min-w-0 flex-1 truncate font-medium leading-none text-foreground">
                    {selectedSource.label}
                  </span>
                  {selectedSource.url ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          onClick={() => void window.api.shell.openUrl(selectedSource.url!)}
                          className="size-6 shrink-0 rounded-sm text-muted-foreground hover:text-foreground"
                          aria-label={translate(
                            'auto.components.new.workspace.SmartWorkspaceNameField.2c69728c2a',
                            'Open link in browser'
                          )}
                        >
                          <ExternalLink className="size-3.5" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="top" sideOffset={6}>
                        {translate(
                          'auto.components.new.workspace.SmartWorkspaceNameField.370a1faf67',
                          'Open in browser'
                        )}
                      </TooltipContent>
                    </Tooltip>
                  ) : null}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        onClick={onClearSelectedSource}
                        className="size-6 shrink-0 rounded-sm text-muted-foreground hover:text-foreground"
                        aria-label={translate(
                          'auto.components.new.workspace.SmartWorkspaceNameField.7199ff19c7',
                          'Clear selected source'
                        )}
                      >
                        <X className="size-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top" sideOffset={6}>
                      {translate(
                        'auto.components.new.workspace.SmartWorkspaceNameField.0c9e668e3a',
                        'Clear'
                      )}
                    </TooltipContent>
                  </Tooltip>
                </div>
              ) : (
                <>
                  <ActiveInputIcon
                    className={cn(
                      'pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground',
                      loading && mode !== 'text' && 'animate-spin'
                    )}
                  />
                  <Input
                    ref={setInputNode}
                    data-workspace-name-input="true"
                    value={value}
                    onPointerDown={() => {
                      if (!disabled && mode !== 'text') {
                        markSourcePopoverUserEngaged()
                        setOpen(true)
                      }
                    }}
                    onChange={(event) => {
                      onValueChange(event.target.value)
                      if (!disabled && mode !== 'text') {
                        markSourcePopoverUserEngaged()
                        setOpen(true)
                      }
                    }}
                    onFocus={(event) => {
                      // Why: only open on focus from another composer control (Tab); dialog autofocus from outside stays suppressed.
                      if (!isComposerFieldToFieldFocus(event)) {
                        return
                      }
                      markSourcePopoverUserEngaged()
                      tryOpenSourcePopover()
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Tab' && event.shiftKey) {
                        const activeTrigger = tabsListRef.current?.querySelector<HTMLElement>(
                          `[data-smart-name-mode="${mode}"]`
                        )
                        if (activeTrigger) {
                          event.preventDefault()
                          activeTrigger.focus()
                          return
                        }
                      }
                      if (
                        event.key === 'Enter' &&
                        !event.metaKey &&
                        !event.ctrlKey &&
                        !event.shiftKey
                      ) {
                        // Why: an Enter that only commits a CJK IME candidate
                        // must not select a row or advance focus — moving focus
                        // mid-composition makes Chromium re-commit the composed
                        // character into the controlled input, duplicating the
                        // last syllable (e.g. 배포 → 배포포).
                        if (isImeCompositionKeyDown(event)) {
                          return
                        }
                        if (open && rows.length > 0) {
                          const row = rows.find((entry) => entry.value === resolvedCommandValue)
                          if (row) {
                            event.preventDefault()
                            handleSelect(row)
                            return
                          }
                          // No highlighted row (e.g. cleared stale GitHub/Linear results); fall through to onPlainEnter so the keypress isn't inert.
                        }
                        onPlainEnter?.()
                      }
                      if (event.key === 'Escape' && open) {
                        event.stopPropagation()
                        setOpen(false)
                      }
                    }}
                    placeholder={placeholder}
                    disabled={disabled}
                    // Why: match the project/run-on comboboxes' solid `bg-background` — the input's
                    // default transparent fill made it read a different color on light mode.
                    className="h-9 bg-background pl-8 text-sm"
                  />
                </>
              )}
            </div>
          </PopoverAnchor>
          <PopoverContent
            align="start"
            sideOffset={4}
            className="popover-scroll-content flex w-[var(--radix-popover-trigger-width)] flex-col p-0"
            // Why: capped height so the result list can't cover the create-workspace dialog's submit footer while typing.
            style={{ maxHeight: 'min(var(--radix-popover-content-available-height,7rem),7rem)' }}
            onOpenAutoFocus={(event) => event.preventDefault()}
            onPointerDownOutside={(event) => {
              // Why: input is a PopoverAnchor not Trigger, so Radix counts clicks on it as outside; keep input/mode-tab clicks from closing results.
              const target = event.target as Node
              if (
                localInputRef.current?.contains(target) ||
                tabsListRef.current?.contains(target)
              ) {
                event.preventDefault()
              }
            }}
            onFocusOutside={(event) => {
              const target = event.target as Node
              if (
                localInputRef.current?.contains(target) ||
                tabsListRef.current?.contains(target)
              ) {
                event.preventDefault()
              }
            }}
          >
            {mode === 'gitlab' ? (
              // Why: MR-state filter mirrors gitlab.com's merge-requests tab strip so web-UI users find a familiar control.
              <div
                className="flex shrink-0 items-center gap-1 border-b border-border/40 px-2 py-1.5"
                onMouseDown={(e) => e.preventDefault()}
              >
                {mrStateFilters.map(({ id, label }) => (
                  <Button
                    key={id}
                    type="button"
                    variant={mrStateFilter === id ? 'secondary' : 'ghost'}
                    size="sm"
                    onClick={() => setMrStateFilter(id)}
                    className="h-6 px-2 text-xs"
                  >
                    {label}
                  </Button>
                ))}
              </div>
            ) : null}
            <CommandList className="!max-h-none min-h-0 flex-1 scrollbar-sleek">
              {typedTextActionRow ? (
                <div
                  className="sticky top-0 z-10 border-b border-border/40 bg-popover p-1"
                  onMouseDown={(event) => event.preventDefault()}
                >
                  <CommandItem
                    key={typedTextActionRow.value}
                    value={typedTextActionRow.value}
                    onSelect={() => handleSelect(typedTextActionRow)}
                    className={getRowItemClassName(typedTextActionRow, { pinnedAction: true })}
                  >
                    <RowIcon row={typedTextActionRow} />
                    <RowLabel row={typedTextActionRow} />
                  </CommandItem>
                </div>
              ) : null}
              {loading && searchResultRows.length === 0 ? (
                <div className="space-y-1 p-1">
                  {[0, 1, 2].map((index) => (
                    <div key={index} className="h-8 animate-pulse rounded bg-muted/40" />
                  ))}
                </div>
              ) : searchResultRows.length === 0 && !typedTextActionRow ? (
                <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                  {mode === 'linear' && linearStatusChecked && !linearStatus.connected
                    ? translate(
                        'auto.components.new.workspace.SmartWorkspaceNameField.3e8bb1176a',
                        'Connect Linear in Settings to search issues.'
                      )
                    : getSmartWorkspaceEmptyHint(mode)}
                </div>
              ) : searchResultRows.length > 0 ? (
                <CommandGroup className="p-1">
                  {searchResultRows.map((row) => (
                    <CommandItem
                      key={row.value}
                      value={row.value}
                      onSelect={() => handleSelect(row)}
                      className={getRowItemClassName(row)}
                    >
                      <RowIcon row={row} />
                      <RowLabel row={row} />
                    </CommandItem>
                  ))}
                </CommandGroup>
              ) : null}
            </CommandList>
          </PopoverContent>
        </Command>
      </Popover>
      <Dialog
        open={crossRepoPrompt !== null}
        onOpenChange={(next) => !next && dismissCrossRepoPrompt()}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{crossRepoSwitchTitle}</DialogTitle>
            <DialogDescription>
              {translate(
                'auto.components.new.workspace.SmartWorkspaceNameField.ad188067ae',
                'The GitHub URL points to'
              )}{' '}
              {crossRepoPrompt?.link.slug.owner}/{crossRepoPrompt?.link.slug.repo}
              {crossRepoSwitchDescriptionSuffix}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={dismissCrossRepoPrompt}>
              {translate(
                'auto.components.new.workspace.SmartWorkspaceNameField.6859e2896c',
                'Cancel'
              )}
            </Button>
            <Button variant="outline" onClick={() => void handleUseCurrentRepo()}>
              {translate(
                'auto.components.new.workspace.SmartWorkspaceNameField.eadf877af5',
                'Keep'
              )}{' '}
              {selectedRepo?.displayName ?? crossRepoSwitchFallbackLabel}
            </Button>
            {crossRepoPrompt?.matchingRepo ? (
              <Button onClick={() => void acceptGitHubLink(crossRepoPrompt.matchingRepo!)}>
                {translate(
                  'auto.components.new.workspace.SmartWorkspaceNameField.a76fcb4fa0',
                  'Switch to'
                )}{' '}
                {crossRepoPrompt.matchingRepo.displayName}
              </Button>
            ) : allowCrossRepoProjectAdd ? (
              <Button onClick={() => void handleAddMatchingRepo()}>
                {translate(
                  'auto.components.new.workspace.SmartWorkspaceNameField.e57c53727c',
                  'Add project...'
                )}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function RowIcon({ row }: { row: RowEntry }): React.JSX.Element {
  if (row.kind === 'use-name') {
    return <CaseSensitive className="size-3.5 shrink-0 text-muted-foreground" />
  }
  if (row.kind === 'create-branch') {
    return <GitBranchPlus className="size-3.5 shrink-0 text-muted-foreground" />
  }
  if (row.kind === 'github') {
    return row.item.type === 'pr' ? (
      <GitPullRequest className="size-3.5 shrink-0 text-muted-foreground" />
    ) : (
      <CircleDot className="size-3.5 shrink-0 text-muted-foreground" />
    )
  }
  if (row.kind === 'gitlab') {
    // Why: MRs use GitMerge (not GitPullRequest, which reads like GitBranch at this size) and match gitlab.com's MR iconography.
    return row.item.type === 'mr' ? (
      <GitMerge className="size-3.5 shrink-0 text-muted-foreground" />
    ) : (
      <CircleDot className="size-3.5 shrink-0 text-muted-foreground" />
    )
  }
  if (row.kind === 'branch') {
    return <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
  }
  return <LinearIcon className="size-3.5 shrink-0 text-muted-foreground" />
}

function SelectionIcon({ kind }: { kind: SmartWorkspaceNameSelection['kind'] }): React.JSX.Element {
  if (kind === 'github-pr') {
    return <GitPullRequest className="size-3.5 shrink-0 text-muted-foreground" />
  }
  if (kind === 'gitlab-mr') {
    // Why: GitMerge keeps MRs distinct from PRs and branches (see RowIcon).
    return <GitMerge className="size-3.5 shrink-0 text-muted-foreground" />
  }
  if (kind === 'github-issue' || kind === 'gitlab-issue') {
    return <CircleDot className="size-3.5 shrink-0 text-muted-foreground" />
  }
  if (kind === 'branch') {
    return <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
  }
  if (kind === 'jira') {
    return <JiraIcon className="size-3.5 shrink-0 text-muted-foreground" />
  }
  return <LinearIcon className="size-3.5 shrink-0 text-muted-foreground" />
}

function RowLabel({ row }: { row: RowEntry }): React.JSX.Element {
  if (row.kind === 'use-name') {
    return (
      <span className="min-w-0 truncate">
        {translate('auto.components.new.workspace.SmartWorkspaceNameField.b1a7d679ba', 'Use')}{' '}
        <span className="font-medium text-foreground">
          {translate('auto.components.new.workspace.SmartWorkspaceNameField.34ca97bce3', '"')}
          {row.name}
          {translate('auto.components.new.workspace.SmartWorkspaceNameField.766083a596', '"')}
        </span>{' '}
        {translate(
          'auto.components.new.workspace.SmartWorkspaceNameField.a44229ce4d',
          'as workspace name'
        )}
      </span>
    )
  }
  if (row.kind === 'create-branch') {
    return (
      <span className="min-w-0 truncate">
        {translate(
          'auto.components.new.workspace.SmartWorkspaceNameField.2a0d535f69',
          'Create new branch'
        )}{' '}
        <span className="font-mono text-[11px] font-medium text-foreground">{row.name}</span>
      </span>
    )
  }
  if (row.kind === 'github') {
    return (
      <span className="min-w-0 truncate">
        <span className="font-medium text-foreground">#{row.item.number}</span> {row.item.title}
      </span>
    )
  }
  if (row.kind === 'gitlab') {
    // Why: GitLab uses `!N` for MRs and `#N` for issues (gitlab.com convention).
    const prefix = row.item.type === 'mr' ? '!' : '#'
    return (
      <span className="min-w-0 truncate">
        <span className="font-medium text-foreground">
          {prefix}
          {row.item.number}
        </span>{' '}
        {row.item.title}
      </span>
    )
  }
  if (row.kind === 'branch') {
    return <span className="min-w-0 truncate font-mono text-[11px]">{row.refName}</span>
  }
  return (
    <span className="min-w-0 truncate">
      <span className="font-medium text-foreground">{row.issue.identifier}</span> {row.issue.title}
    </span>
  )
}

function sameSlug(left: RepoSlug, right: RepoSlug): boolean {
  return githubRepoIdentityKey(left) === githubRepoIdentityKey(right)
}

export async function getRepoSlugCached(
  repo: Pick<RepoOption, 'id' | 'path'>,
  sourceContext: TaskSourceContext | null | undefined,
  cache: Map<string, RepoSlug>
): Promise<RepoSlug | null> {
  const cacheKey = sourceContext
    ? `${getTaskSourceCacheScope(sourceContext)}\0${repo.path}`
    : `local:${repo.id}\0${repo.path}`
  if (cache.has(cacheKey)) {
    return cache.get(cacheKey) ?? null
  }
  try {
    const target = getGitHubSourceRuntimeTarget(sourceContext)
    const slug =
      target.kind === 'environment'
        ? await callRuntimeRpc<RepoSlug | null>(
            target,
            'github.repoSlug',
            { repo: getGitHubRuntimeRepoId(sourceContext, repo.id) },
            { timeoutMs: 30_000 }
          )
        : await window.api.gh.repoSlug({ repoPath: repo.path, repoId: repo.id })
    if (slug) {
      cache.set(cacheKey, slug)
    }
    return slug
  } catch {
    return null
  }
}

type RepoSlugTarget = {
  repo: RepoOption
  sourceContext: TaskSourceContext | null | undefined
}

async function findMatchingRepoForSlug(
  targets: RepoSlugTarget[],
  slug: RepoSlug,
  cache: Map<string, RepoSlug>
): Promise<RepoSlugTarget | null> {
  for (const target of targets) {
    const candidate = await getRepoSlugCached(target.repo, target.sourceContext, cache)
    if (candidate && sameSlug(candidate, slug)) {
      return target
    }
  }
  return null
}

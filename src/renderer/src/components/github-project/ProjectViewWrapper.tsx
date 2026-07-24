/* eslint-disable max-lines -- Why: top-level Project-mode container coordinates picker, view selection, query overrides, fetch lifecycle, and toolbar interactions; splitting these would fragment shared state. */
// Top-level Project-mode container; interaction states per the design doc.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ExternalLink,
  RefreshCw,
  KanbanSquare,
  Map as MapIcon,
  Search,
  Table as TableIcon,
  X
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import GitHubItemDialog, { type GitHubItemDialogProjectOrigin } from '@/components/GitHubItemDialog'
import { GhAuthErrorHelp } from '@/components/github-project/GhAuthErrorHelp'
import { launchWorkItemDirect } from '@/lib/launch-work-item-direct'
import { useRepoSlugIndex } from '@/lib/repo-slug-index'
import { cn } from '@/lib/utils'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { useAppStore } from '@/store'
import { useMountedRef } from '@/hooks/useMountedRef'
import { projectViewCacheKey } from '@/store/slices/github'
import type {
  GetProjectViewTableResult,
  GitHubIssueType,
  GitHubProjectFieldMutationValue,
  GitHubProjectRow,
  GitHubProjectTable,
  GitHubProjectViewError,
  GitHubProjectViewSummary,
  ListProjectViewsResult
} from '../../../../shared/github-project-types'
import type { GitHubWorkItem } from '../../../../shared/types'
import ProjectPicker, { type ResolvedProjectSelection } from './ProjectPicker'
import ProjectViewList from './ProjectViewList'
import ProjectItemSlugDialog from './ProjectItemSlugDialog'
import {
  filterProjectTableRowsBySelectedRepos,
  resolveSelectedProjectRowRepo
} from './project-row-filtering'
import {
  resolveMissingRepoProjectDialogState,
  resolveRepoBackedProjectDialogState
} from './project-dialog-state'
import {
  getSelectedRepoFingerprint,
  getNextVisibleProjectTableCache,
  getVisibleProjectTable,
  type CachedVisibleProjectTable
} from './project-visible-table-cache'
import { translate } from '@/i18n/i18n'
import { buildTaskSourceContextFromRepo } from '../../../../shared/task-source-context'
import {
  githubProjectHost,
  githubProjectIdentityKey
} from '../../../../shared/github-project-identity'

type Props = {
  selectedRepoIds: ReadonlySet<string>
}

const ORCA_FEATURE_REQUEST_URL = 'https://github.com/stablyai/orca/issues/new'

function listProjectViewsForRuntime(
  settings: Parameters<typeof getActiveRuntimeTarget>[0],
  args: {
    owner: string
    ownerType: 'organization' | 'user'
    projectNumber: number
    host?: string
  }
): Promise<ListProjectViewsResult> {
  const target = getActiveRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<ListProjectViewsResult>(target, 'github.project.listViews', args, {
        timeoutMs: 30_000
      })
    : window.api.gh.listProjectViews(args)
}

function getProjectViewSourceScope(settings: Parameters<typeof getActiveRuntimeTarget>[0]): string {
  const target = getActiveRuntimeTarget(settings)
  return target.kind === 'environment' ? `runtime:${target.environmentId}` : 'local'
}

export function buildProjectWorkItem(
  row: GitHubProjectRow,
  repoId: string,
  host?: string
): GitHubWorkItem | null {
  if (row.itemType !== 'ISSUE' && row.itemType !== 'PULL_REQUEST') {
    return null
  }
  if (row.content.number == null || !row.content.url) {
    return null
  }
  const [owner, repo] = row.content.repository?.split('/') ?? []
  // Why: Project rows can reach mutation controls before detail hydration, so
  // preserve their host-bearing repository identity on the initial item.
  const prRepo = owner && repo ? { owner, repo, host: githubProjectHost(host) } : undefined
  return {
    id: `${row.itemType === 'PULL_REQUEST' ? 'pr' : 'issue'}:${row.content.number}`,
    type: row.itemType === 'PULL_REQUEST' ? 'pr' : 'issue',
    number: row.content.number,
    title: row.content.title,
    state:
      row.content.state === 'MERGED'
        ? 'merged'
        : row.content.state === 'CLOSED'
          ? 'closed'
          : row.content.isDraft
            ? 'draft'
            : 'open',
    url: row.content.url,
    labels: row.content.labels.map((label) => label.name),
    updatedAt: row.updatedAt,
    author: null,
    repoId,
    prRepo
  }
}

export default function ProjectViewWrapper({ selectedRepoIds }: Props): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const projectViewCache = useAppStore((s) => s.projectViewCache)
  const fetchProjectViewTable = useAppStore((s) => s.fetchProjectViewTable)
  const updateProjectFieldValue = useAppStore((s) => s.updateProjectFieldValue)
  const clearProjectFieldValue = useAppStore((s) => s.clearProjectFieldValue)
  const patchProjectIssueOrPr = useAppStore((s) => s.patchProjectIssueOrPr)
  const patchProjectRowIssueType = useAppStore((s) => s.patchProjectRowIssueType)
  const addRepoFromStore = useAppStore((s) => s.addRepo)
  const repos = useAppStore((s) => s.repos)
  const { lookupSlug, ready: slugIndexReady } = useRepoSlugIndex()
  const mountedRef = useMountedRef()

  const activeProject = settings?.githubProjects?.activeProject ?? null
  const projectViewSourceScope = useMemo(() => getProjectViewSourceScope(settings), [settings])
  const lastViewByProject = useMemo(
    () => settings?.githubProjects?.lastViewByProject ?? {},
    [settings?.githubProjects?.lastViewByProject]
  )

  const [loading, setLoading] = useState(false)
  const fetchRunIdRef = useRef(0)
  const [error, setError] = useState<{
    error: GitHubProjectViewError
    totalCount?: number
  } | null>(null)
  const [parentDroppedToasted, setParentDroppedToasted] = useState<ReadonlySet<string>>(
    () => new Set()
  )
  // Why: cache view list per project so the tab strip doesn't flicker/refetch on re-render; keyed `ownerType:owner:number`.
  const [viewListByProject, setViewListByProject] = useState<
    Record<string, GitHubProjectViewSummary[]>
  >({})

  // Why: ephemeral per-(project,view) search override, never persisted (design doc §"Out of scope"); `undefined` = use the view's filter as-is.
  const [appliedQueryByView, setAppliedQueryByView] = useState<Record<string, string>>({})

  const doFetch = useCallback(
    async (selection: ResolvedProjectSelection, force = false, queryOverride?: string) => {
      const runId = fetchRunIdRef.current + 1
      fetchRunIdRef.current = runId
      setLoading(true)
      setError(null)
      try {
        const res: GetProjectViewTableResult = await fetchProjectViewTable(
          {
            owner: selection.owner,
            ownerType: selection.ownerType,
            projectNumber: selection.projectNumber,
            host: githubProjectHost(selection.host),
            ...(selection.viewId ? { viewId: selection.viewId } : {}),
            ...(queryOverride !== undefined ? { queryOverride } : {})
          },
          { force }
        )
        if (!mountedRef.current || fetchRunIdRef.current !== runId) {
          return
        }
        if (!res.ok) {
          setError({ error: res.error, totalCount: res.totalCount })
        }
      } finally {
        // Why: an older overlapping fetch finishing first must not clear a newer refresh's loading indicator.
        if (mountedRef.current && fetchRunIdRef.current === runId) {
          setLoading(false)
        }
      }
    },
    [fetchProjectViewTable, mountedRef]
  )

  const handleSelect = useCallback(
    async (selection: ResolvedProjectSelection) => {
      await doFetch(selection, true)
    },
    [doFetch]
  )

  // Auto-fetch when activeProject exists and we don't have cached data.
  useEffect(() => {
    if (!activeProject) {
      return
    }
    const key = githubProjectIdentityKey(activeProject)
    const viewId = lastViewByProject[key]?.viewId
    if (!viewId) {
      return
    }
    const projectViewKey = `${projectViewSourceScope}:${key}:${viewId}`
    const queryOverride = appliedQueryByView[projectViewKey]
    const cacheKey = projectViewCacheKey(
      activeProject.ownerType,
      activeProject.owner,
      activeProject.number,
      viewId,
      queryOverride,
      projectViewSourceScope,
      activeProject.host
    )
    if (projectViewCache[cacheKey]?.data) {
      return
    }
    void doFetch(
      {
        owner: activeProject.owner,
        ownerType: activeProject.ownerType,
        projectNumber: activeProject.number,
        host: githubProjectHost(activeProject.host),
        viewId
      },
      false,
      queryOverride
    )
  }, [
    activeProject,
    lastViewByProject,
    projectViewCache,
    doFetch,
    appliedQueryByView,
    projectViewSourceScope
  ])

  // Load the view list once per project per session (small, rarely changes) so the tab strip can render.
  useEffect(() => {
    if (!activeProject) {
      return
    }
    const projectKey = `${projectViewSourceScope}:${githubProjectIdentityKey(activeProject)}`
    if (viewListByProject[projectKey]) {
      return
    }
    let cancelled = false
    void listProjectViewsForRuntime(settings, {
      owner: activeProject.owner,
      ownerType: activeProject.ownerType,
      projectNumber: activeProject.number,
      host: githubProjectHost(activeProject.host)
    })
      .then((res) => {
        if (cancelled) {
          return
        }
        if (res.ok) {
          setViewListByProject((prev) => ({ ...prev, [projectKey]: res.views }))
        } else {
          console.warn('[project-view] listProjectViews failed:', res.error.message)
        }
      })
      .catch((err) => {
        if (cancelled) {
          return
        }
        // Why: swallow the IPC rejection (else unhandled/dev-tools red); fall back to the empty-tabs UI.
        console.warn('[project-view] listProjectViews threw:', err)
      })
    return () => {
      cancelled = true
    }
  }, [activeProject, viewListByProject, settings, projectViewSourceScope])

  const handleSwitchView = useCallback(
    async (viewId: string) => {
      if (!activeProject) {
        return
      }
      const projectKey = githubProjectIdentityKey(activeProject)
      const current = lastViewByProject[projectKey]?.viewId
      if (current === viewId) {
        return
      }
      // Why: read freshest settings via getState() so a concurrent pin/recent mutation isn't clobbered on write.
      const freshSettings = useAppStore.getState().settings
      const prevSettings = freshSettings?.githubProjects ?? {
        pinned: [],
        recent: [],
        lastViewByProject: {},
        activeProject: null
      }
      await useAppStore.getState().updateSettings({
        githubProjects: {
          ...prevSettings,
          lastViewByProject: {
            ...prevSettings.lastViewByProject,
            [projectKey]: { viewId }
          }
        }
      })
      await doFetch({
        owner: activeProject.owner,
        ownerType: activeProject.ownerType,
        projectNumber: activeProject.number,
        host: githubProjectHost(activeProject.host),
        viewId
      })
    },
    [activeProject, doFetch, lastViewByProject]
  )

  const currentProjectViewKey = useMemo(() => {
    if (!activeProject) {
      return null
    }
    const key = githubProjectIdentityKey(activeProject)
    const viewId = lastViewByProject[key]?.viewId
    if (!viewId) {
      return null
    }
    return `${projectViewSourceScope}:${key}:${viewId}`
  }, [activeProject, lastViewByProject, projectViewSourceScope])

  const currentAppliedOverride = currentProjectViewKey
    ? appliedQueryByView[currentProjectViewKey]
    : undefined

  const currentCacheKey = useMemo(() => {
    if (!activeProject) {
      return null
    }
    const key = githubProjectIdentityKey(activeProject)
    const viewId = lastViewByProject[key]?.viewId
    if (!viewId) {
      return null
    }
    return projectViewCacheKey(
      activeProject.ownerType,
      activeProject.owner,
      activeProject.number,
      viewId,
      currentAppliedOverride,
      projectViewSourceScope,
      activeProject.host
    )
  }, [activeProject, lastViewByProject, currentAppliedOverride, projectViewSourceScope])

  const table: GitHubProjectTable | null = currentCacheKey
    ? (projectViewCache[currentCacheKey]?.data ?? null)
    : null
  const selectedRepoFingerprint = useMemo(
    () => getSelectedRepoFingerprint(selectedRepoIds),
    [selectedRepoIds]
  )
  const filteredTable = useMemo(
    () =>
      table && slugIndexReady
        ? filterProjectTableRowsBySelectedRepos(table, lookupSlug, slugIndexReady, selectedRepoIds)
        : null,
    [table, slugIndexReady, lookupSlug, selectedRepoIds]
  )
  const lastFilteredTableRef = useRef<CachedVisibleProjectTable | null>(null)
  // Why: ref-cache prevents a blank table while the slug index rebuilds, without forcing a second render.
  lastFilteredTableRef.current = getNextVisibleProjectTableCache({
    currentCacheKey,
    selectedRepoFingerprint,
    sourceTable: table,
    slugIndexReady,
    filteredTable,
    previous: lastFilteredTableRef.current
  })
  const visibleTable = getVisibleProjectTable({
    currentCacheKey,
    selectedRepoFingerprint,
    slugIndexReady,
    filteredTable,
    cachedTable: lastFilteredTableRef.current
  })

  // Parent-dropped toast, once per table.
  useEffect(() => {
    if (!table || !currentCacheKey || !table.parentFieldDropped) {
      return
    }
    if (parentDroppedToasted.has(currentCacheKey)) {
      return
    }
    toast.message(
      translate(
        'auto.components.github.project.ProjectViewWrapper.22df63c393',
        'Sub-issue data is unavailable for your token.'
      )
    )
    setParentDroppedToasted((prev) => {
      const next = new Set(prev)
      next.add(currentCacheKey)
      return next
    })
  }, [table, currentCacheKey, parentDroppedToasted])

  const selectedViewUrl = table
    ? `${table.project.url}/views/${table.selectedView.number ?? ''}`
    : null

  // Why: matched-repo rows open `GitHubItemDialog`, unmatched the slug dialog; `repoNotInOrca` drives the `repo-not-in-orca` modal.
  const [dialogRepoItem, setDialogRepoItem] = useState<{
    workItem: GitHubWorkItem
    repoPath: string
    repoId: string
    origin: GitHubItemDialogProjectOrigin
  } | null>(null)
  // Why: slug dialog only serves unregistered-repo rows; the parent (not this dialog) owns the repo-not-in-orca "Start work" flow.
  const [slugDialog, setSlugDialog] = useState<{
    origin: GitHubItemDialogProjectOrigin
  } | null>(null)
  const [repoNotInOrca, setRepoNotInOrca] = useState<{
    owner: string
    repo: string
    host?: string
    url: string | null
  } | null>(null)
  const liveRepoIds = useMemo(() => new Set(repos.map((repo) => repo.id)), [repos])

  const resolvedDialogRepoItem = resolveRepoBackedProjectDialogState(
    dialogRepoItem,
    liveRepoIds,
    selectedRepoIds
  )
  if (resolvedDialogRepoItem !== dialogRepoItem) {
    // Why: clear the repo-backed dialog when its repo leaves Orca, before the modal tree gets stale repo ids.
    setDialogRepoItem(resolvedDialogRepoItem)
  }
  const resolvedDialogRepo = resolvedDialogRepoItem
    ? (repos.find((repo) => repo.id === resolvedDialogRepoItem.repoId) ?? null)
    : null
  const resolvedDialogSourceContext = resolvedDialogRepo
    ? buildTaskSourceContextFromRepo({
        provider: 'github',
        projectId: resolvedDialogRepo.id,
        repo: resolvedDialogRepo
      })
    : null

  const resolvedMissingRepoDialogs = resolveMissingRepoProjectDialogState({
    slugIndexReady,
    slugDialog,
    repoNotInOrca,
    lookupSlug,
    selectedRepoIds
  })
  if (resolvedMissingRepoDialogs.slugDialog !== slugDialog) {
    // Why: once a missing repo is registered, rows switch to the full repo-backed dialog, not the slug fallback.
    setSlugDialog(resolvedMissingRepoDialogs.slugDialog)
  }
  if (resolvedMissingRepoDialogs.repoNotInOrca !== repoNotInOrca) {
    setRepoNotInOrca(resolvedMissingRepoDialogs.repoNotInOrca)
  }

  const buildOrigin = useCallback(
    (
      row: GitHubProjectRow,
      cacheKey: string,
      table: GitHubProjectTable
    ): GitHubItemDialogProjectOrigin | null => {
      if (row.itemType !== 'ISSUE' && row.itemType !== 'PULL_REQUEST') {
        return null
      }
      if (row.content.number == null || !row.content.repository) {
        return null
      }
      const [owner, repo] = row.content.repository.split('/')
      if (!owner || !repo) {
        return null
      }
      return {
        owner,
        repo,
        host: githubProjectHost(table.project.host),
        number: row.content.number,
        type: row.itemType === 'PULL_REQUEST' ? 'pr' : 'issue',
        projectId: table.project.id,
        projectItemId: row.id,
        cacheKey
      }
    },
    []
  )

  const openProjectRowUrlWithToast = useCallback((row: GitHubProjectRow, message: string) => {
    if (row.content.url) {
      void window.api.shell.openUrl(row.content.url)
    }
    toast.message(message)
  }, [])

  const handleOpenDialog = useCallback(
    (row: GitHubProjectRow) => {
      if (!currentCacheKey || !table) {
        return
      }
      const origin = buildOrigin(row, currentCacheKey, table)
      if (!origin) {
        // Redacted / draft / missing slug — fall back to opening GitHub.
        if (row.content.url) {
          void window.api.shell.openUrl(row.content.url)
        }
        return
      }
      const resolution = resolveSelectedProjectRowRepo({
        row,
        lookupSlug,
        host: table.project.host,
        slugIndexReady,
        selectedRepoIds
      })
      if (resolution.status === 'loading') {
        openProjectRowUrlWithToast(
          row,
          translate(
            'auto.components.github.project.ProjectViewWrapper.f352abf7c3',
            'Repository list is updating.'
          )
        )
        return
      }
      if (resolution.status === 'selected_match') {
        const workItem = buildProjectWorkItem(row, resolution.repo.id, table.project.host)
        if (workItem) {
          setDialogRepoItem({
            workItem,
            repoPath: resolution.repo.path,
            repoId: resolution.repo.id,
            origin
          })
          return
        }
      }
      if (resolution.status === 'no_global_match') {
        // Unknown repo — use the simplified slug-mode dialog.
        setSlugDialog({ origin })
        return
      }
      if (resolution.status === 'unselected_match') {
        openProjectRowUrlWithToast(
          row,
          translate(
            'auto.components.github.project.ProjectViewWrapper.1ce21b8cff',
            'This item is outside the selected repositories.'
          )
        )
        return
      }
      if (resolution.status === 'ambiguous_selected_match') {
        openProjectRowUrlWithToast(
          row,
          translate(
            'auto.components.github.project.ProjectViewWrapper.030de75bc5',
            'This item matches multiple selected repositories.'
          )
        )
      }
    },
    [
      currentCacheKey,
      table,
      buildOrigin,
      lookupSlug,
      slugIndexReady,
      selectedRepoIds,
      openProjectRowUrlWithToast
    ]
  )

  const handleStartWork = useCallback(
    (row: GitHubProjectRow) => {
      if (!currentCacheKey || !table) {
        return
      }
      const origin = buildOrigin(row, currentCacheKey, table)
      if (!origin) {
        return
      }
      const resolution = resolveSelectedProjectRowRepo({
        row,
        lookupSlug,
        host: table.project.host,
        slugIndexReady,
        selectedRepoIds
      })
      if (resolution.status === 'loading') {
        openProjectRowUrlWithToast(
          row,
          translate(
            'auto.components.github.project.ProjectViewWrapper.f352abf7c3',
            'Repository list is updating.'
          )
        )
        return
      }
      if (resolution.status === 'no_global_match') {
        setRepoNotInOrca({
          owner: origin.owner,
          repo: origin.repo,
          host: origin.host,
          url: row.content.url ?? null
        })
        return
      }
      if (resolution.status === 'unselected_match') {
        openProjectRowUrlWithToast(
          row,
          translate(
            'auto.components.github.project.ProjectViewWrapper.1ce21b8cff',
            'This item is outside the selected repositories.'
          )
        )
        return
      }
      if (resolution.status === 'ambiguous_selected_match') {
        openProjectRowUrlWithToast(
          row,
          translate(
            'auto.components.github.project.ProjectViewWrapper.030de75bc5',
            'This item matches multiple selected repositories.'
          )
        )
        return
      }
      if (resolution.status !== 'selected_match') {
        return
      }
      const workItem = buildProjectWorkItem(row, resolution.repo.id, table.project.host)
      if (!workItem) {
        return
      }
      // Why: issue #4756 changed only TaskPage's "Create workspace"; Project view stays on direct "start work now" launch.
      void launchWorkItemDirect({
        item: workItem,
        repoId: resolution.repo.id,
        launchSource: 'task_page',
        telemetrySource: 'sidebar',
        openModalFallback: () => {
          // Why: Project mode lacks the new-workspace composer, so when launch needs user input, open the URL instead of a silent no-op.
          if (row.content.url) {
            void window.api.shell.openUrl(row.content.url)
          }
        }
      })
    },
    [
      currentCacheKey,
      table,
      buildOrigin,
      lookupSlug,
      slugIndexReady,
      selectedRepoIds,
      openProjectRowUrlWithToast
    ]
  )

  const handleEditAssignees = useCallback(
    async (row: GitHubProjectRow, add: string[], remove: string[]) => {
      if (!currentCacheKey) {
        return
      }
      const res = await patchProjectIssueOrPr(currentCacheKey, row.id, {
        ...(add.length ? { addAssignees: add } : {}),
        ...(remove.length ? { removeAssignees: remove } : {})
      })
      if (!res.ok) {
        toast.error(res.error.message)
      }
    },
    [currentCacheKey, patchProjectIssueOrPr]
  )

  const handleEditLabels = useCallback(
    async (row: GitHubProjectRow, add: string[], remove: string[]) => {
      if (!currentCacheKey) {
        return
      }
      const res = await patchProjectIssueOrPr(currentCacheKey, row.id, {
        ...(add.length ? { addLabels: add } : {}),
        ...(remove.length ? { removeLabels: remove } : {})
      })
      if (!res.ok) {
        toast.error(res.error.message)
      }
    },
    [currentCacheKey, patchProjectIssueOrPr]
  )

  const handleEditIssueType = useCallback(
    async (row: GitHubProjectRow, issueType: GitHubIssueType | null) => {
      if (!currentCacheKey) {
        return
      }
      const res = await patchProjectRowIssueType(currentCacheKey, row.id, issueType)
      if (!res.ok) {
        toast.error(res.error.message)
      }
    },
    [currentCacheKey, patchProjectRowIssueType]
  )

  const handleEditField = useCallback(
    async (
      row: GitHubProjectRow,
      fieldId: string,
      value: GitHubProjectFieldMutationValue | null
    ) => {
      if (!currentCacheKey) {
        return
      }
      const result =
        value === null
          ? await clearProjectFieldValue(currentCacheKey, row.id, fieldId)
          : await updateProjectFieldValue(currentCacheKey, row.id, fieldId, value)
      if (!result.ok) {
        toast.error(result.error.message)
      }
    },
    [clearProjectFieldValue, currentCacheKey, updateProjectFieldValue]
  )

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex min-w-0 flex-none flex-wrap items-center gap-2 border-b border-border/50 bg-muted/30 px-3 py-2">
        <ProjectPicker
          activeProject={
            activeProject && table
              ? {
                  owner: activeProject.owner,
                  ownerType: activeProject.ownerType,
                  number: activeProject.number,
                  host: githubProjectHost(activeProject.host),
                  title: table.project.title
                }
              : activeProject
                ? {
                    owner: activeProject.owner,
                    ownerType: activeProject.ownerType,
                    number: activeProject.number,
                    host: githubProjectHost(activeProject.host)
                  }
                : null
          }
          onSelect={handleSelect}
        />
        {currentProjectViewKey ? (
          // Why: keep search box mounted through refetches so it doesn't vanish; `key` resets input per (project, view).
          <ProjectSearchInput
            key={currentProjectViewKey}
            viewFilter={table?.selectedView.filter ?? ''}
            appliedOverride={appliedQueryByView[currentProjectViewKey]}
            onApply={(nextOverride) => {
              if (!activeProject) {
                return
              }
              const key = githubProjectIdentityKey(activeProject)
              const viewId = lastViewByProject[key]?.viewId
              if (!viewId) {
                return
              }
              setAppliedQueryByView((prev) => {
                const next = { ...prev }
                if (nextOverride === undefined) {
                  delete next[currentProjectViewKey]
                } else {
                  next[currentProjectViewKey] = nextOverride
                }
                return next
              })
              // Why: force-fetch on user apply so a re-typed or TTL-cached query doesn't silently no-op.
              void doFetch(
                {
                  owner: activeProject.owner,
                  ownerType: activeProject.ownerType,
                  projectNumber: activeProject.number,
                  host: githubProjectHost(activeProject.host),
                  viewId
                },
                true,
                nextOverride
              )
            }}
          />
        ) : null}
        {table ? (
          <>
            <span className="ml-auto rounded-full border border-border/50 bg-background px-2 py-0.5 text-[11px]">
              {visibleTable?.totalCount ?? table.totalCount}
            </span>
            {selectedViewUrl ? (
              <Button
                variant="outline"
                size="icon"
                className="h-7 w-7"
                onClick={() => void window.api.shell.openUrl(selectedViewUrl)}
                aria-label={translate(
                  'auto.components.github.project.ProjectViewWrapper.fd15491034',
                  'Open view in GitHub'
                )}
              >
                <ExternalLink className="size-3.5" />
              </Button>
            ) : null}
            <Button
              variant="outline"
              size="icon"
              className="h-7 w-7 cursor-pointer disabled:pointer-events-auto disabled:cursor-wait"
              onClick={() => {
                if (!activeProject || !currentCacheKey) {
                  return
                }
                const key = githubProjectIdentityKey(activeProject)
                const viewId = lastViewByProject[key]?.viewId
                if (!viewId) {
                  return
                }
                void doFetch(
                  {
                    owner: activeProject.owner,
                    ownerType: activeProject.ownerType,
                    projectNumber: activeProject.number,
                    host: githubProjectHost(activeProject.host),
                    viewId
                  },
                  true,
                  currentAppliedOverride
                )
              }}
              disabled={loading}
              aria-busy={loading}
              aria-label={
                loading
                  ? translate(
                      'auto.components.github.project.ProjectViewWrapper.a8fa0d2bf5',
                      'Refreshing'
                    )
                  : translate(
                      'auto.components.github.project.ProjectViewWrapper.71fb69926c',
                      'Refresh'
                    )
              }
              title={
                loading
                  ? translate(
                      'auto.components.github.project.ProjectViewWrapper.a8fa0d2bf5',
                      'Refreshing'
                    )
                  : translate(
                      'auto.components.github.project.ProjectViewWrapper.71fb69926c',
                      'Refresh'
                    )
              }
            >
              <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
            </Button>
          </>
        ) : null}
      </div>

      {activeProject
        ? (() => {
            const projectKey = githubProjectIdentityKey(activeProject)
            const scopedProjectKey = `${projectViewSourceScope}:${projectKey}`
            const views = viewListByProject[scopedProjectKey] ?? []
            const activeViewId = lastViewByProject[projectKey]?.viewId ?? null
            return (
              <ViewTabStrip
                views={views}
                activeViewId={activeViewId}
                onPick={(viewId) => void handleSwitchView(viewId)}
              />
            )
          })()
        : null}

      {!activeProject ? (
        <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
          {translate(
            'auto.components.github.project.ProjectViewWrapper.512fc171d6',
            'Choose a project to get started.'
          )}
        </div>
      ) : loading && !table ? (
        <ProjectTableSkeleton />
      ) : error ? (
        <ErrorState
          error={error.error}
          totalCount={error.totalCount}
          host={activeProject.host}
          onOpenInGitHub={() => {
            if (selectedViewUrl) {
              void window.api.shell.openUrl(selectedViewUrl)
            }
          }}
        />
      ) : visibleTable && resolvedDialogRepoItem ? (
        <GitHubItemDialog
          workItem={resolvedDialogRepoItem.workItem}
          repoPath={resolvedDialogRepoItem.repoPath}
          repoId={resolvedDialogRepoItem.repoId}
          sourceContext={resolvedDialogSourceContext}
          projectOrigin={resolvedDialogRepoItem.origin}
          backLabel={translate(
            'auto.components.github.project.ProjectViewWrapper.1aa7c952b9',
            'Project view'
          )}
          onUse={(item) => {
            const current = resolvedDialogRepoItem
            setDialogRepoItem(null)
            // Why: issue #4756 keeps project-view actions on the direct "start work now" path, not the TaskPage background-create flow.
            void launchWorkItemDirect({
              item,
              repoId: current.workItem.repoId,
              launchSource: 'task_page',
              telemetrySource: 'sidebar',
              openModalFallback: () => {
                if (item.url) {
                  void window.api.shell.openUrl(item.url)
                }
              }
            })
          }}
          onClose={() => setDialogRepoItem(null)}
        />
      ) : visibleTable ? (
        <ProjectViewList
          table={visibleTable}
          onOpenDialog={handleOpenDialog}
          onEditField={handleEditField}
          onEditAssignees={(row, add, remove) => void handleEditAssignees(row, add, remove)}
          onEditLabels={(row, add, remove) => void handleEditLabels(row, add, remove)}
          onEditIssueType={(row, issueType) => void handleEditIssueType(row, issueType)}
          onOpenInBrowser={(row) => {
            if (row.content.url) {
              void window.api.shell.openUrl(row.content.url)
            }
          }}
          onStartWork={handleStartWork}
          sourceSettings={settings}
        />
      ) : null}

      {/* Slug-only dialog for unadded-repo rows; Start-work lives in the parent's `repoNotInOrca` modal, not here (avoids a confusing duplicate button). */}
      <ProjectItemSlugDialog
        projectOrigin={resolvedMissingRepoDialogs.slugDialog?.origin ?? null}
        sourceSettings={settings}
        onClose={() => setSlugDialog(null)}
      />

      {/* repo-not-in-orca prompt: see design doc Interaction States. */}
      <Dialog
        open={resolvedMissingRepoDialogs.repoNotInOrca !== null}
        onOpenChange={(open) => !open && setRepoNotInOrca(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {translate(
                'auto.components.github.project.ProjectViewWrapper.7037c8f5f1',
                'Repository not in Orca'
              )}
            </DialogTitle>
            <DialogDescription>
              {resolvedMissingRepoDialogs.repoNotInOrca
                ? translate(
                    'auto.components.github.project.ProjectViewWrapper.1850fceac8',
                    "{{value0}}/{{value1}} isn't added to Orca. Add it to start work, or open in GitHub.",
                    {
                      value0: resolvedMissingRepoDialogs.repoNotInOrca.owner,
                      value1: resolvedMissingRepoDialogs.repoNotInOrca.repo
                    }
                  )
                : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:justify-end">
            <Button variant="ghost" onClick={() => setRepoNotInOrca(null)}>
              {translate('auto.components.github.project.ProjectViewWrapper.dffa899f36', 'Cancel')}
            </Button>
            {resolvedMissingRepoDialogs.repoNotInOrca?.url ? (
              <Button
                variant="outline"
                onClick={() => {
                  if (resolvedMissingRepoDialogs.repoNotInOrca?.url) {
                    void window.api.shell.openUrl(resolvedMissingRepoDialogs.repoNotInOrca.url)
                  }
                  setRepoNotInOrca(null)
                }}
              >
                {translate(
                  'auto.components.github.project.ProjectViewWrapper.23b87ba9f7',
                  'Open in GitHub'
                )}
              </Button>
            ) : null}
            <Button
              onClick={async () => {
                // Why: `addRepo` opens the OS folder picker (auto-clone is out of v1 scope); close the modal regardless so a cancelled picker doesn't trap the user.
                setRepoNotInOrca(null)
                await addRepoFromStore()
              }}
            >
              {translate(
                'auto.components.github.project.ProjectViewWrapper.840c268665',
                'Add repo'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// Why: keeps the input string local so typing doesn't re-render the parent/table; the parent only learns it on apply (Enter/blur/clear).
function ProjectSearchInput({
  viewFilter,
  appliedOverride,
  onApply
}: {
  viewFilter: string
  appliedOverride: string | undefined
  onApply: (nextOverride: string | undefined) => void
}): React.JSX.Element {
  const initial = appliedOverride !== undefined ? appliedOverride : viewFilter
  const [value, setValue] = useState<string>(initial)
  const inputRef = useRef<HTMLInputElement>(null)
  const applied = appliedOverride !== undefined ? appliedOverride : viewFilter
  const dirty = value !== applied

  const apply = (next: string): void => {
    // Why: reverting to the view's stored filter drops the override so the cache key collapses to the unfiltered entry.
    onApply(next === viewFilter ? undefined : next)
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const isMac = navigator.userAgent.includes('Mac')
      const modifierPressed = isMac ? event.metaKey : event.ctrlKey
      if (!modifierPressed || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'f') {
        return
      }
      if (document.querySelector('[role="dialog"]')) {
        return
      }

      const input = inputRef.current
      if (!input) {
        return
      }
      const target = event.target
      if (
        target instanceof HTMLElement &&
        target !== input &&
        (target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement ||
          target.isContentEditable)
      ) {
        return
      }

      event.preventDefault()
      event.stopPropagation()
      input.focus()
      input.select()
    }

    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [])

  return (
    <div className="relative min-w-0 max-w-xl flex-1 basis-64">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        ref={inputRef}
        data-github-project-search-input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            if (e.nativeEvent.isComposing) {
              return
            }
            e.preventDefault()
            apply(value)
          } else if (e.key === 'Escape') {
            setValue(applied)
            ;(e.target as HTMLInputElement).blur()
          }
        }}
        onBlur={() => {
          if (dirty) {
            apply(value)
          }
        }}
        placeholder={
          viewFilter ||
          translate(
            'auto.components.github.project.ProjectViewWrapper.067119985c',
            'GitHub search, e.g. assignee:@me is:open'
          )
        }
        title={
          viewFilter
            ? translate(
                'auto.components.github.project.ProjectViewWrapper.c5bc7ec007',
                'View filter: {{value0}}',
                { value0: viewFilter }
              )
            : undefined
        }
        className={cn(
          'h-7 rounded-md border-border/50 bg-background pl-8 pr-7 text-[11px]',
          dirty && 'border-amber-500/50'
        )}
      />
      {value ? (
        <button
          type="button"
          aria-label={translate(
            'auto.components.github.project.ProjectViewWrapper.7245c3d7ac',
            'Clear search'
          )}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            setValue('')
            apply('')
          }}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground transition hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      ) : null}
    </div>
  )
}

function ViewTabStrip({
  views,
  activeViewId,
  onPick
}: {
  views: GitHubProjectViewSummary[]
  activeViewId: string | null
  onPick: (viewId: string) => void
}): React.JSX.Element {
  // Why: emulate GitHub Projects' tab strip; non-table layouts stay visible but disabled.
  return (
    <div className="project-view-tab-strip flex min-h-[41px] min-w-0 flex-none items-end gap-1 overflow-x-auto overflow-y-hidden border-b border-border/50 bg-muted/20 px-3 pt-3">
      {views.map((v) => {
        const supported = v.layout === 'TABLE_LAYOUT'
        const active = v.id === activeViewId
        const layoutLabel =
          v.layout === 'BOARD_LAYOUT'
            ? 'Board'
            : v.layout === 'ROADMAP_LAYOUT'
              ? 'Roadmap'
              : 'Table'
        const Icon =
          v.layout === 'BOARD_LAYOUT'
            ? KanbanSquare
            : v.layout === 'ROADMAP_LAYOUT'
              ? MapIcon
              : TableIcon
        const tab = (
          <button
            key={v.id}
            type="button"
            disabled={!supported}
            onClick={() => onPick(v.id)}
            title={
              supported
                ? v.name
                : translate(
                    'auto.components.github.project.ProjectViewWrapper.2edf5e7e77',
                    "{{value0}} — Orca doesn't support {{value1}} project views yet. File a feature request at {{value2}}.",
                    { value0: v.name, value1: layoutLabel, value2: ORCA_FEATURE_REQUEST_URL }
                  )
            }
            className={cn(
              'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-t-md border-x border-t px-3 py-1.5 text-xs',
              active
                ? '-mb-px border-border/60 bg-background text-foreground'
                : 'border-transparent text-muted-foreground hover:bg-background/40 hover:text-foreground',
              !supported &&
                'pointer-events-none cursor-not-allowed opacity-50 hover:bg-transparent hover:text-muted-foreground'
            )}
          >
            <Icon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className={cn(active && 'font-medium')}>{v.name}</span>
          </button>
        )
        if (supported) {
          return tab
        }
        const unsupportedMessage = `Orca doesn't support ${layoutLabel} project views yet.`
        return (
          <HoverCard key={v.id} openDelay={200} closeDelay={100}>
            <HoverCardTrigger asChild>
              <span
                tabIndex={0}
                aria-label={translate(
                  'auto.components.github.project.ProjectViewWrapper.55de4fb57a',
                  '{{value0}}. {{value1}} File a feature request at {{value2}}.',
                  { value0: v.name, value1: unsupportedMessage, value2: ORCA_FEATURE_REQUEST_URL }
                )}
                className="inline-flex shrink-0 cursor-not-allowed rounded-t-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                {tab}
              </span>
            </HoverCardTrigger>
            <HoverCardContent side="bottom" align="start" sideOffset={8} className="w-72 p-3">
              <div className="space-y-2">
                <p className="text-xs leading-5 text-muted-foreground">
                  {unsupportedMessage}{' '}
                  {translate(
                    'auto.components.github.project.ProjectViewWrapper.1bf8c01c8b',
                    'Switch to a Table view to work with this project in Orca.'
                  )}
                </p>
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  onClick={() => void window.api.shell.openUrl(ORCA_FEATURE_REQUEST_URL)}
                >
                  {translate(
                    'auto.components.github.project.ProjectViewWrapper.4d2a77a119',
                    'File feature request'
                  )}
                  <ExternalLink className="size-3" />
                </Button>
              </div>
            </HoverCardContent>
          </HoverCard>
        )
      })}
    </div>
  )
}

function ErrorState({
  error,
  totalCount,
  host,
  onOpenInGitHub
}: {
  error: GitHubProjectViewError
  totalCount?: number
  host?: string
  onOpenInGitHub: () => void
}): React.JSX.Element {
  // Auth/scope errors get a richer `gh auth status` remediation UI; bail early before the generic block.
  if (error.type === 'auth_required' || error.type === 'scope_missing') {
    return (
      <div className="flex flex-1 flex-col items-start gap-3 p-6 text-sm">
        <GhAuthErrorHelp
          error={error as GitHubProjectViewError & { type: 'auth_required' | 'scope_missing' }}
          host={host}
        />
        <Button size="sm" variant="outline" onClick={onOpenInGitHub}>
          <ExternalLink className="mr-1 size-3.5" />{' '}
          {translate(
            'auto.components.github.project.ProjectViewWrapper.23b87ba9f7',
            'Open in GitHub'
          )}
        </Button>
      </div>
    )
  }
  const copy =
    error.type === 'too_large'
      ? `This view has ${totalCount ?? 'many'} items — too large to render in Orca. Narrow the view's filter on GitHub.`
      : error.type === 'unsupported_layout'
        ? 'Orca only renders table views yet. This is a Board or Roadmap view.'
        : error.type === 'not_found'
          ? 'Could not find this project or view.'
          : error.type === 'schema_drift'
            ? 'Could not read this project view.'
            : error.message
  return (
    <div className="flex flex-1 flex-col items-start gap-3 p-6 text-sm">
      <div className="text-muted-foreground">{copy}</div>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={onOpenInGitHub}>
          <ExternalLink className="mr-1 size-3.5" />{' '}
          {translate(
            'auto.components.github.project.ProjectViewWrapper.23b87ba9f7',
            'Open in GitHub'
          )}
        </Button>
      </div>
    </div>
  )
}

// Why: mirror ProjectViewList's header + 12 rows so the table doesn't jump in height when real data lands.
function ProjectTableSkeleton(): React.JSX.Element {
  const headerCols = 6
  const bodyCols = 5
  return (
    <div
      aria-busy="true"
      aria-label={translate(
        'auto.components.github.project.ProjectViewWrapper.463f1205c0',
        'Loading project view'
      )}
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
    >
      <div className="grid items-center gap-3 border-b border-border/60 bg-background/95 px-3 py-2">
        <div
          className="grid items-center gap-3"
          style={{
            gridTemplateColumns: `repeat(${headerCols}, minmax(0, 1fr))`
          }}
        >
          {Array.from({ length: headerCols }).map((_, i) => (
            <div key={i} className="h-3 w-20 animate-pulse rounded bg-muted/70" />
          ))}
        </div>
      </div>
      <div className="divide-y divide-border/30">
        {Array.from({ length: 12 }).map((_, i) => (
          <div
            key={i}
            className="grid min-h-10 items-center gap-3 px-3 py-2"
            style={{ gridTemplateColumns: `repeat(${bodyCols}, minmax(0, 1fr))` }}
          >
            <div className="h-4 w-3/5 animate-pulse rounded bg-muted/70" />
            <div className="h-4 w-4/5 animate-pulse rounded bg-muted/70" />
            <div className="h-4 w-2/5 animate-pulse rounded-full bg-muted/60" />
            <div className="h-4 w-3/5 animate-pulse rounded bg-muted/60" />
            <div className="h-4 w-1/2 animate-pulse rounded bg-muted/60" />
          </div>
        ))}
      </div>
    </div>
  )
}

/* eslint-disable max-lines -- Why: top-level Project-mode container coordinates picker, view selection, query overrides, fetch lifecycle, and toolbar interactions; splitting these would fragment shared state. */
// Why: top-level container for Project mode. Handles the picker, header,
// filter label, count pill, Open-in-GitHub, and all Interaction States
// documented in the design doc.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ExternalLink,
  Loader,
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
import GitHubItemDialog, { type GitHubItemDialogProjectOrigin } from '@/components/GitHubItemDialog'
import { GhAuthErrorHelp } from '@/components/github-project/GhAuthErrorHelp'
import { launchWorkItemDirect } from '@/lib/launch-work-item-direct'
import { useRepoSlugIndex } from '@/lib/repo-slug-index'
import { cn } from '@/lib/utils'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { useAppStore } from '@/store'
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

type Props = Record<string, never>

function listProjectViewsForRuntime(
  settings: Parameters<typeof getActiveRuntimeTarget>[0],
  args: { owner: string; ownerType: 'organization' | 'user'; projectNumber: number }
): Promise<ListProjectViewsResult> {
  const target = getActiveRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<ListProjectViewsResult>(target, 'github.project.listViews', args, {
        timeoutMs: 30_000
      })
    : window.api.gh.listProjectViews(args)
}

export default function ProjectViewWrapper(_props: Props = {} as Props): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const projectViewCache = useAppStore((s) => s.projectViewCache)
  const fetchProjectViewTable = useAppStore((s) => s.fetchProjectViewTable)
  const updateProjectFieldValue = useAppStore((s) => s.updateProjectFieldValue)
  const clearProjectFieldValue = useAppStore((s) => s.clearProjectFieldValue)
  const patchProjectIssueOrPr = useAppStore((s) => s.patchProjectIssueOrPr)
  const patchProjectRowIssueType = useAppStore((s) => s.patchProjectRowIssueType)
  const addRepoFromStore = useAppStore((s) => s.addRepo)
  const lookupSlug = useRepoSlugIndex()

  const activeProject = settings?.githubProjects?.activeProject ?? null
  const lastViewByProject = useMemo(
    () => settings?.githubProjects?.lastViewByProject ?? {},
    [settings?.githubProjects?.lastViewByProject]
  )

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<{
    error: GitHubProjectViewError
    totalCount?: number
  } | null>(null)
  const [parentDroppedToasted, setParentDroppedToasted] = useState<ReadonlySet<string>>(
    () => new Set()
  )
  // Why: cache the project's view list per active project so the tab strip
  // renders without flicker on re-renders and survives view switches without
  // refetching. Keyed by `ownerType:owner:number`.
  const [viewListByProject, setViewListByProject] = useState<
    Record<string, GitHubProjectViewSummary[]>
  >({})

  // Why: ephemeral search override, scoped to (project, view). Mirrors GitHub
  // Projects' search box — pre-populated from `selectedView.filter`, applied
  // on Enter/blur, cleared with the X button. The override is NEVER persisted
  // to settings or to GitHub (per design doc §"Out of scope" line 36); a tab
  // switch or refresh resets to the view's stored filter. Keyed by
  // `ownerType:owner:number:viewId`. `undefined` (entry missing) means
  // "use the view's filter as-is" so the cache key collapses to the
  // unfiltered cache entry. The transient input string lives inside
  // `ProjectSearchInput` so typing does not re-render the table.
  const [appliedQueryByView, setAppliedQueryByView] = useState<Record<string, string>>({})

  const doFetch = useCallback(
    async (selection: ResolvedProjectSelection, force = false, queryOverride?: string) => {
      setLoading(true)
      setError(null)
      try {
        const res: GetProjectViewTableResult = await fetchProjectViewTable(
          {
            owner: selection.owner,
            ownerType: selection.ownerType,
            projectNumber: selection.projectNumber,
            ...(selection.viewId ? { viewId: selection.viewId } : {}),
            ...(queryOverride !== undefined ? { queryOverride } : {})
          },
          { force }
        )
        if (!res.ok) {
          setError({ error: res.error, totalCount: res.totalCount })
        }
      } finally {
        setLoading(false)
      }
    },
    [fetchProjectViewTable]
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
    const key = `${activeProject.ownerType}:${activeProject.owner}:${activeProject.number}`
    const viewId = lastViewByProject[key]?.viewId
    if (!viewId) {
      return
    }
    const projectViewKey = `${key}:${viewId}`
    const queryOverride = appliedQueryByView[projectViewKey]
    const cacheKey = projectViewCacheKey(
      activeProject.ownerType,
      activeProject.owner,
      activeProject.number,
      viewId,
      queryOverride
    )
    if (projectViewCache[cacheKey]?.data) {
      return
    }
    void doFetch(
      {
        owner: activeProject.owner,
        ownerType: activeProject.ownerType,
        projectNumber: activeProject.number,
        viewId
      },
      false,
      queryOverride
    )
  }, [activeProject, lastViewByProject, projectViewCache, doFetch, appliedQueryByView])

  // Load the project's view list whenever the active project changes so the
  // tab strip can render. The list is small and rarely changes — fetched once
  // per project per session is fine.
  useEffect(() => {
    if (!activeProject) {
      return
    }
    const projectKey = `${activeProject.ownerType}:${activeProject.owner}:${activeProject.number}`
    if (viewListByProject[projectKey]) {
      return
    }
    let cancelled = false
    void listProjectViewsForRuntime(settings, {
      owner: activeProject.owner,
      ownerType: activeProject.ownerType,
      projectNumber: activeProject.number
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
        // Why: an IPC rejection here would surface as an unhandled rejection
        // and dev-tools red — log and fall back to the empty-tabs UI.
        console.warn('[project-view] listProjectViews threw:', err)
      })
    return () => {
      cancelled = true
    }
  }, [activeProject, viewListByProject, settings])

  const handleSwitchView = useCallback(
    async (viewId: string) => {
      if (!activeProject) {
        return
      }
      const projectKey = `${activeProject.ownerType}:${activeProject.owner}:${activeProject.number}`
      const current = lastViewByProject[projectKey]?.viewId
      if (current === viewId) {
        return
      }
      // Persist the new view selection so reloads & the picker stay in sync.
      // Why: read the freshest settings via getState() rather than the closure-
      // captured `settings` — between callback creation and invocation another
      // mutation (pin/recent update from elsewhere) may have landed, and the
      // closure value would clobber it on write.
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
        viewId
      })
    },
    [activeProject, doFetch, lastViewByProject]
  )

  const currentProjectViewKey = useMemo(() => {
    if (!activeProject) {
      return null
    }
    const key = `${activeProject.ownerType}:${activeProject.owner}:${activeProject.number}`
    const viewId = lastViewByProject[key]?.viewId
    if (!viewId) {
      return null
    }
    return `${key}:${viewId}`
  }, [activeProject, lastViewByProject])

  const currentAppliedOverride = currentProjectViewKey
    ? appliedQueryByView[currentProjectViewKey]
    : undefined

  const currentCacheKey = useMemo(() => {
    if (!activeProject) {
      return null
    }
    const key = `${activeProject.ownerType}:${activeProject.owner}:${activeProject.number}`
    const viewId = lastViewByProject[key]?.viewId
    if (!viewId) {
      return null
    }
    return projectViewCacheKey(
      activeProject.ownerType,
      activeProject.owner,
      activeProject.number,
      viewId,
      currentAppliedOverride
    )
  }, [activeProject, lastViewByProject, currentAppliedOverride])

  const table: GitHubProjectTable | null = currentCacheKey
    ? (projectViewCache[currentCacheKey]?.data ?? null)
    : null

  // Parent-dropped toast, once per table.
  useEffect(() => {
    if (!table || !currentCacheKey || !table.parentFieldDropped) {
      return
    }
    if (parentDroppedToasted.has(currentCacheKey)) {
      return
    }
    toast.message('Sub-issue data is unavailable for your token.')
    setParentDroppedToasted((prev) => {
      const next = new Set(prev)
      next.add(currentCacheKey)
      return next
    })
  }, [table, currentCacheKey, parentDroppedToasted])

  const selectedViewUrl = table
    ? `${table.project.url}/views/${table.selectedView.number ?? ''}`
    : null

  // ── Row action state ────────────────────────────────────────────────
  // Why: when a row matches a registered repo, we open the full
  // `GitHubItemDialog` in repo-backed mode; when it doesn't, we open the
  // simplified slug-mode dialog. `repoNotInOrca` drives the fallback modal
  // from the design doc's `repo-not-in-orca` interaction state.
  const [dialogRepoItem, setDialogRepoItem] = useState<{
    workItem: GitHubWorkItem
    repoPath: string
    repoId: string
    origin: GitHubItemDialogProjectOrigin
  } | null>(null)
  // Why: the slug dialog is only opened for rows whose repo isn't registered
  // in Orca (matched repos go through the full GitHubItemDialog above), so
  // there's no `matchedRepo` to track here. The repo-not-in-orca modal —
  // owned by this parent, not the slug dialog — handles "Start work".
  const [slugDialog, setSlugDialog] = useState<{
    origin: GitHubItemDialogProjectOrigin
  } | null>(null)
  const [repoNotInOrca, setRepoNotInOrca] = useState<{
    owner: string
    repo: string
    url: string | null
  } | null>(null)

  const buildWorkItem = useCallback(
    (row: GitHubProjectRow, repoId: string): GitHubWorkItem | null => {
      if (row.itemType !== 'ISSUE' && row.itemType !== 'PULL_REQUEST') {
        return null
      }
      if (row.content.number == null || !row.content.url) {
        return null
      }
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
        labels: row.content.labels.map((l) => l.name),
        updatedAt: row.updatedAt,
        author: null,
        repoId
      }
    },
    []
  )

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
        number: row.content.number,
        type: row.itemType === 'PULL_REQUEST' ? 'pr' : 'issue',
        projectId: table.project.id,
        projectItemId: row.id,
        cacheKey
      }
    },
    []
  )

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
      const matches = lookupSlug(`${origin.owner}/${origin.repo}`)
      const matched = matches.length === 1 ? matches[0] : null
      if (matched) {
        const workItem = buildWorkItem(row, matched.id)
        if (workItem) {
          setDialogRepoItem({ workItem, repoPath: matched.path, repoId: matched.id, origin })
          return
        }
      }
      // Unknown repo — use the simplified slug-mode dialog.
      setSlugDialog({ origin })
    },
    [currentCacheKey, table, buildOrigin, lookupSlug, buildWorkItem]
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
      const matches = lookupSlug(`${origin.owner}/${origin.repo}`)
      const matched = matches.length === 1 ? matches[0] : null
      if (!matched) {
        setRepoNotInOrca({
          owner: origin.owner,
          repo: origin.repo,
          url: row.content.url ?? null
        })
        return
      }
      const workItem = buildWorkItem(row, matched.id)
      if (!workItem) {
        return
      }
      void launchWorkItemDirect({
        item: workItem,
        repoId: matched.id,
        launchSource: 'task_page',
        telemetrySource: 'sidebar',
        openModalFallback: () => {
          // Why: Project mode does not own the new-workspace composer modal.
          // When `launchWorkItemDirect` wants user input (setupRunPolicy:'ask'
          // or agent detection fails), fall back to opening the URL so the
          // user keeps a path forward rather than a silent no-op.
          if (row.content.url) {
            void window.api.shell.openUrl(row.content.url)
          }
        }
      })
    },
    [currentCacheKey, table, buildOrigin, lookupSlug, buildWorkItem]
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
      <div className="flex flex-none items-center gap-2 border-b border-border/50 bg-muted/30 px-3 py-2">
        <ProjectPicker
          activeProject={
            activeProject && table
              ? {
                  owner: activeProject.owner,
                  ownerType: activeProject.ownerType,
                  number: activeProject.number,
                  title: table.project.title
                }
              : activeProject
                ? {
                    owner: activeProject.owner,
                    ownerType: activeProject.ownerType,
                    number: activeProject.number
                  }
                : null
          }
          onSelect={handleSelect}
        />
        {currentProjectViewKey ? (
          // Why: render the search input whenever a view is selected — even
          // while a refetch is in flight and `table` has briefly cleared for
          // the new cache key. Hiding the search box mid-search would make
          // it look like the search vanished. `key` keeps the local input
          // state stable across (project, view) changes only.
          <ProjectSearchInput
            key={currentProjectViewKey}
            viewFilter={table?.selectedView.filter ?? ''}
            appliedOverride={appliedQueryByView[currentProjectViewKey]}
            onApply={(nextOverride) => {
              if (!activeProject) {
                return
              }
              const key = `${activeProject.ownerType}:${activeProject.owner}:${activeProject.number}`
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
              // Why: force-fetch on user-initiated apply so the same
              // query re-typed (or cache-stale entries within TTL) does
              // not silently no-op.
              void doFetch(
                {
                  owner: activeProject.owner,
                  ownerType: activeProject.ownerType,
                  projectNumber: activeProject.number,
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
              {table.totalCount}
            </span>
            {selectedViewUrl ? (
              <Button
                variant="outline"
                size="icon"
                className="h-7 w-7"
                onClick={() => void window.api.shell.openUrl(selectedViewUrl)}
                aria-label="Open view in GitHub"
              >
                <ExternalLink className="size-3.5" />
              </Button>
            ) : null}
            <Button
              variant="outline"
              size="icon"
              className="h-7 w-7"
              onClick={() => {
                if (!activeProject || !currentCacheKey) {
                  return
                }
                const key = `${activeProject.ownerType}:${activeProject.owner}:${activeProject.number}`
                const viewId = lastViewByProject[key]?.viewId
                if (!viewId) {
                  return
                }
                void doFetch(
                  {
                    owner: activeProject.owner,
                    ownerType: activeProject.ownerType,
                    projectNumber: activeProject.number,
                    viewId
                  },
                  true,
                  currentAppliedOverride
                )
              }}
              aria-label="Refresh"
            >
              <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
            </Button>
          </>
        ) : null}
      </div>

      {activeProject
        ? (() => {
            const projectKey = `${activeProject.ownerType}:${activeProject.owner}:${activeProject.number}`
            const views = viewListByProject[projectKey] ?? []
            if (views.length === 0) {
              return null
            }
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
          Choose a project to get started.
        </div>
      ) : loading && !table ? (
        <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
          <Loader className="mr-2 size-4 animate-spin" />
          Loading project view…
        </div>
      ) : error ? (
        <ErrorState
          error={error.error}
          totalCount={error.totalCount}
          onOpenInGitHub={() => {
            if (selectedViewUrl) {
              void window.api.shell.openUrl(selectedViewUrl)
            }
          }}
        />
      ) : table ? (
        <ProjectViewList
          table={table}
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
        />
      ) : null}

      {/* Full repo-backed dialog — writes still go through slug-addressed
          mutation helpers (see design §Dialog editing from Project rows, line
          707) so a row from another repo cannot accidentally edit the active
          workspace. */}
      <GitHubItemDialog
        workItem={dialogRepoItem?.workItem ?? null}
        repoPath={dialogRepoItem?.repoPath ?? null}
        repoId={dialogRepoItem?.repoId ?? null}
        projectOrigin={dialogRepoItem?.origin}
        onUse={(item) => {
          const current = dialogRepoItem
          setDialogRepoItem(null)
          if (!current) {
            return
          }
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

      {/* Slug-only simplified dialog for rows whose repo isn't added to Orca.
          Why: no Start-work affordance lives inside the slug dialog — the
          parent's `handleStartWork`/`repoNotInOrca` modal owns that flow, so
          having a duplicate (always-disabled or always-routing-to-fallback)
          button here would only confuse the user. */}
      <ProjectItemSlugDialog
        projectOrigin={slugDialog?.origin ?? null}
        onClose={() => setSlugDialog(null)}
      />

      {/* repo-not-in-orca prompt: see design doc Interaction States. */}
      <Dialog
        open={repoNotInOrca !== null}
        onOpenChange={(open) => !open && setRepoNotInOrca(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Repository not in Orca</DialogTitle>
            <DialogDescription>
              {repoNotInOrca
                ? `${repoNotInOrca.owner}/${repoNotInOrca.repo} isn't added to Orca. Add it to start work, or open in GitHub.`
                : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:justify-end">
            <Button variant="ghost" onClick={() => setRepoNotInOrca(null)}>
              Cancel
            </Button>
            {repoNotInOrca?.url ? (
              <Button
                variant="outline"
                onClick={() => {
                  if (repoNotInOrca.url) {
                    void window.api.shell.openUrl(repoNotInOrca.url)
                  }
                  setRepoNotInOrca(null)
                }}
              >
                Open in GitHub
              </Button>
            ) : null}
            <Button
              onClick={async () => {
                // Why: `addRepo` opens the OS folder picker — it's the only
                // non-destructive way to register a repo today. Auto-cloning
                // from a row click is out of v1 scope (design doc §Row
                // actions). Close the modal regardless so the user isn't
                // trapped if they cancel the picker.
                setRepoNotInOrca(null)
                await addRepoFromStore()
              }}
            >
              Add repo
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// Why: owns the transient search input string locally so typing does not
// re-render the parent (and therefore not the table). The parent only learns
// the value when the user applies it (Enter/blur/clear), which is the only
// moment that should trigger a refetch. Pre-populated from the view's stored
// filter and remounted (via `key`) when the active project/view changes.
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
    // Why: when the user reverts to the view's stored filter, drop the
    // override so the cache key collapses back onto the unfiltered entry.
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
    <div className="relative min-w-[280px] flex-1 max-w-xl">
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
        placeholder={viewFilter || 'GitHub search, e.g. assignee:@me is:open'}
        title={viewFilter ? `View filter: ${viewFilter}` : undefined}
        className={cn(
          'h-7 rounded-md border-border/50 bg-background pl-8 pr-7 text-[11px]',
          dirty && 'border-amber-500/50'
        )}
      />
      {value ? (
        <button
          type="button"
          aria-label="Clear search"
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
  // Why: emulate GitHub Projects' tab strip — pill-shaped active tab with
  // layout icon, sitting on a muted base bar with a bottom border. Inactive
  // tabs are flat text; active gets a card background + outline. Disabled
  // (non-table) layouts stay visible at low opacity.
  return (
    <div className="flex flex-none items-end gap-1 overflow-x-auto border-b border-border/50 bg-muted/20 px-3 pt-3">
      {views.map((v) => {
        const supported = v.layout === 'TABLE_LAYOUT'
        const active = v.id === activeViewId
        const Icon =
          v.layout === 'BOARD_LAYOUT'
            ? KanbanSquare
            : v.layout === 'ROADMAP_LAYOUT'
              ? MapIcon
              : TableIcon
        return (
          <button
            key={v.id}
            type="button"
            disabled={!supported}
            onClick={() => onPick(v.id)}
            title={
              supported
                ? v.name
                : `${v.name} — ${
                    v.layout === 'BOARD_LAYOUT' ? 'Board' : 'Roadmap'
                  } layouts aren't supported in Orca yet. Open this view on GitHub to see it, or switch to a Table view to work with it here.`
            }
            className={cn(
              'inline-flex shrink-0 items-center gap-1.5 rounded-t-md border-x border-t px-3 py-1.5 text-xs',
              active
                ? '-mb-px border-border/60 bg-background text-foreground'
                : 'border-transparent text-muted-foreground hover:bg-background/40 hover:text-foreground',
              !supported &&
                'cursor-not-allowed opacity-50 hover:bg-transparent hover:text-muted-foreground'
            )}
          >
            <Icon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className={cn(active && 'font-medium')}>{v.name}</span>
          </button>
        )
      })}
    </div>
  )
}

function ErrorState({
  error,
  totalCount,
  onOpenInGitHub
}: {
  error: GitHubProjectViewError
  totalCount?: number
  onOpenInGitHub: () => void
}): React.JSX.Element {
  // Auth/scope errors get a richer remediation UI driven by `gh auth
  // status`. Bail early so the generic `command`/`copy` block below is
  // only computed for non-auth error types.
  if (error.type === 'auth_required' || error.type === 'scope_missing') {
    return (
      <div className="flex flex-1 flex-col items-start gap-3 p-6 text-sm">
        <GhAuthErrorHelp
          error={error as GitHubProjectViewError & { type: 'auth_required' | 'scope_missing' }}
        />
        <Button size="sm" variant="outline" onClick={onOpenInGitHub}>
          <ExternalLink className="mr-1 size-3.5" /> Open in GitHub
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
          <ExternalLink className="mr-1 size-3.5" /> Open in GitHub
        </Button>
      </div>
    </div>
  )
}

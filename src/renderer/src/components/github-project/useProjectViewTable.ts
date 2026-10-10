import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { useAppStore } from '@/store'
import { projectViewCacheKey } from '@/store/github/cache-identity'
import type {
  GitHubProjectSettings,
  GitHubProjectTable,
  GitHubProjectViewSummary
} from '../../../../shared/github/project-types'
import type {
  GetProjectViewTableResult,
  GitHubProjectViewError,
  ListProjectViewsResult
} from '../../../../shared/github/project-result-types'
import {
  githubProjectHost,
  githubProjectIdentityKey
} from '../../../../shared/github/project-identity'
import type { ResolvedProjectSelection } from './project-picker-selection'
import { filterProjectTableRowsBySelectedRepos } from './project-row-filtering'
import {
  getNextVisibleProjectTableCache,
  getSelectedRepoFingerprint,
  getVisibleProjectTable,
  type CachedVisibleProjectTable
} from './project-visible-table-cache'
import { useRepoSlugIndex } from '@/lib/repo-slug-index'

type Settings = Parameters<typeof getActiveRuntimeTarget>[0]

async function listProjectViewsForRuntime(
  settings: Settings,
  args: { owner: string; ownerType: 'organization' | 'user'; projectNumber: number; host?: string }
): Promise<ListProjectViewsResult> {
  const target = getActiveRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<ListProjectViewsResult>(target, 'github.project.listViews', args, {
        timeoutMs: 30_000
      })
    : window.api.gh.listProjectViews(args)
}

export function useProjectViewTable(selectedRepoIds: ReadonlySet<string>) {
  const settings = useAppStore((state) => state.settings)
  const projectViewCache = useAppStore((state) => state.projectViewCache)
  const fetchProjectViewTable = useAppStore((state) => state.fetchProjectViewTable)
  const activeProject = settings?.githubProjects?.activeProject ?? null
  const lastViewByProject = settings?.githubProjects?.lastViewByProject ?? {}
  const { lookupSlugMatches, ready: slugIndexReady } = useRepoSlugIndex()
  const mountedRef = useMountedRef()
  const target = getActiveRuntimeTarget(settings)
  const sourceScope = target.kind === 'environment' ? `runtime:${target.environmentId}` : 'local'
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<{ error: GitHubProjectViewError; totalCount?: number } | null>(
    null
  )
  const [viewListByProject, setViewListByProject] = useState<
    Record<string, GitHubProjectViewSummary[]>
  >({})
  const [appliedQueryByView, setAppliedQueryByView] = useState<Record<string, string>>({})
  const parentDroppedToastedRef = useRef<Set<string>>(new Set())
  const fetchRunIdRef = useRef(0)

  const doFetch = useCallback(
    async (selection: ResolvedProjectSelection, force = false, queryOverride?: string) => {
      const runId = ++fetchRunIdRef.current
      setLoading(true)
      setError(null)
      try {
        const result: GetProjectViewTableResult = await fetchProjectViewTable(
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
        if (!result.ok) {
          setError({ error: result.error, totalCount: result.totalCount })
        }
      } finally {
        if (mountedRef.current && fetchRunIdRef.current === runId) {
          setLoading(false)
        }
      }
    },
    [fetchProjectViewTable, mountedRef]
  )

  const projectIdentity = activeProject ? githubProjectIdentityKey(activeProject) : null
  const viewId = projectIdentity ? lastViewByProject[projectIdentity]?.viewId : undefined
  const currentProjectViewKey =
    projectIdentity && viewId ? `${sourceScope}:${projectIdentity}:${viewId}` : null
  const currentAppliedOverride = currentProjectViewKey
    ? appliedQueryByView[currentProjectViewKey]
    : undefined
  const currentCacheKey =
    activeProject && viewId
      ? projectViewCacheKey(
          activeProject.ownerType,
          activeProject.owner,
          activeProject.number,
          viewId,
          currentAppliedOverride,
          sourceScope,
          activeProject.host
        )
      : null
  const table = currentCacheKey ? (projectViewCache[currentCacheKey]?.data ?? null) : null

  useEffect(() => {
    if (!activeProject || !viewId || !currentCacheKey || projectViewCache[currentCacheKey]?.data) {
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
      currentAppliedOverride
    )
  }, [activeProject, currentAppliedOverride, currentCacheKey, doFetch, projectViewCache, viewId])

  useEffect(() => {
    if (!activeProject) {
      return
    }
    const projectKey = `${sourceScope}:${githubProjectIdentityKey(activeProject)}`
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
      .then((result) => {
        if (!cancelled && result.ok) {
          setViewListByProject((previous) => ({ ...previous, [projectKey]: result.views }))
        } else if (!cancelled && !result.ok) {
          console.warn('[project-view] listProjectViews failed:', result.error.message)
        }
      })
      .catch((caught) => {
        if (!cancelled) {
          console.warn('[project-view] listProjectViews threw:', caught)
        }
      })
    return () => {
      cancelled = true
    }
  }, [activeProject, settings, sourceScope, viewListByProject])

  const selectedRepoFingerprint = useMemo(
    () => getSelectedRepoFingerprint(selectedRepoIds),
    [selectedRepoIds]
  )
  const filteredTable = useMemo(
    () =>
      table && slugIndexReady
        ? filterProjectTableRowsBySelectedRepos(
            table,
            lookupSlugMatches,
            slugIndexReady,
            selectedRepoIds
          )
        : null,
    [lookupSlugMatches, selectedRepoIds, slugIndexReady, table]
  )
  const lastFilteredTableRef = useRef<CachedVisibleProjectTable | null>(null)
  const nextVisibleTableCache = getNextVisibleProjectTableCache({
    currentCacheKey,
    selectedRepoFingerprint,
    sourceTable: table,
    slugIndexReady,
    filteredTable,
    previous: lastFilteredTableRef.current
  })
  useLayoutEffect(() => {
    lastFilteredTableRef.current = nextVisibleTableCache
  }, [nextVisibleTableCache])
  const visibleTable = getVisibleProjectTable({
    currentCacheKey,
    selectedRepoFingerprint,
    slugIndexReady,
    filteredTable,
    cachedTable: nextVisibleTableCache
  })

  useEffect(() => {
    if (
      !table?.parentFieldDropped ||
      !currentCacheKey ||
      parentDroppedToastedRef.current.has(currentCacheKey)
    ) {
      return
    }
    parentDroppedToastedRef.current.add(currentCacheKey)
    toast.message(
      translate(
        'auto.components.github.project.ProjectViewWrapper.22df63c393',
        'Sub-issue data is unavailable for your token.'
      )
    )
  }, [currentCacheKey, table])

  const switchView = useCallback(
    async (nextViewId: string) => {
      if (!activeProject || viewId === nextViewId) {
        return
      }
      const freshSettings = useAppStore.getState().settings
      const previous = freshSettings?.githubProjects ?? EMPTY_PROJECT_SETTINGS
      await useAppStore.getState().updateSettings({
        githubProjects: {
          ...previous,
          lastViewByProject: {
            ...previous.lastViewByProject,
            [githubProjectIdentityKey(activeProject)]: { viewId: nextViewId }
          }
        }
      })
      await doFetch({
        owner: activeProject.owner,
        ownerType: activeProject.ownerType,
        projectNumber: activeProject.number,
        host: githubProjectHost(activeProject.host),
        viewId: nextViewId
      })
    },
    [activeProject, doFetch, viewId]
  )

  return {
    settings,
    activeProject,
    sourceScope,
    viewId,
    currentProjectViewKey,
    currentCacheKey,
    currentAppliedOverride,
    table,
    visibleTable,
    loading,
    error,
    views: activeProject
      ? (viewListByProject[`${sourceScope}:${githubProjectIdentityKey(activeProject)}`] ?? [])
      : [],
    appliedQueryByView,
    setAppliedQueryByView,
    doFetch,
    switchView
  }
}

const EMPTY_PROJECT_SETTINGS: GitHubProjectSettings = {
  pinned: [],
  recent: [],
  lastViewByProject: {},
  activeProject: null
}

export type ProjectViewTableState = ReturnType<typeof useProjectViewTable>
export type ProjectViewTable = GitHubProjectTable

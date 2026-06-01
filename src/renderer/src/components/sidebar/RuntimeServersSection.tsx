import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Loader2, Monitor, Plus, RefreshCw, Server } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useAppStore } from '@/store'
import type { Repo } from '../../../../shared/types'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import {
  buildRuntimeServerEntries,
  createEmptyRuntimeServerProjectState,
  getProjectStateWithLoading,
  getRuntimeServerErrorMessage,
  getRuntimeServerProjectActivationWorktree,
  getRuntimeServerProjectLabel,
  sortRuntimeServerProjects,
  type RuntimeServerProjectState
} from './runtime-server-sidebar-model'
import { RuntimeServerProjects } from './RuntimeServerProjects'

export function RuntimeServersSection(): React.JSX.Element | null {
  const mountedRef = useMountedRef()
  const activeRuntimeEnvironmentId = useAppStore(
    (s) => s.settings?.activeRuntimeEnvironmentId ?? null
  )
  const switchRuntimeEnvironment = useAppStore((s) => s.switchRuntimeEnvironment)
  const setActiveRepo = useAppStore((s) => s.setActiveRepo)
  const setActiveView = useAppStore((s) => s.setActiveView)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const activeServerProjects = useAppStore((s) => s.repos)
  const fetchWorktrees = useAppStore((s) => s.fetchWorktrees)
  const [environments, setEnvironments] = useState<PublicKnownRuntimeEnvironment[]>([])
  const [localProjects, setLocalProjects] = useState<RuntimeServerProjectState>(() =>
    createEmptyRuntimeServerProjectState()
  )
  const [remoteProjectsByEnvironmentId, setRemoteProjectsByEnvironmentId] = useState<
    Map<string, RuntimeServerProjectState>
  >(new Map())
  const [expandedServerIds, setExpandedServerIds] = useState<Set<string | null>>(
    () => new Set([activeRuntimeEnvironmentId?.trim() || null])
  )
  const [loadingServers, setLoadingServers] = useState(false)
  const loadServersRequestIdRef = useRef(0)
  const localProjectsRequestIdRef = useRef(0)
  const remoteProjectsRequestIdsRef = useRef(new Map<string, number>())

  const entries = useMemo(
    () =>
      buildRuntimeServerEntries({
        activeRuntimeEnvironmentId,
        environments,
        localProjects,
        remoteProjectsByEnvironmentId
      }),
    [activeRuntimeEnvironmentId, environments, localProjects, remoteProjectsByEnvironmentId]
  )

  const loadServers = useCallback(async (): Promise<void> => {
    const requestId = loadServersRequestIdRef.current + 1
    loadServersRequestIdRef.current = requestId
    setLoadingServers(true)
    try {
      const next = await window.api.runtimeEnvironments.list()
      if (mountedRef.current && requestId === loadServersRequestIdRef.current) {
        const environmentIds = new Set(next.map((environment) => environment.id))
        for (const environmentId of remoteProjectsRequestIdsRef.current.keys()) {
          if (!environmentIds.has(environmentId)) {
            remoteProjectsRequestIdsRef.current.delete(environmentId)
          }
        }
        setEnvironments(next)
        setExpandedServerIds((current) => {
          const pruned = new Set(
            [...current].filter((serverId) => serverId === null || environmentIds.has(serverId))
          )
          return pruned.size === current.size ? current : pruned
        })
        setRemoteProjectsByEnvironmentId((current) => {
          const pruned = new Map<string, RuntimeServerProjectState>()
          for (const [environmentId, state] of current) {
            if (environmentIds.has(environmentId)) {
              pruned.set(environmentId, state)
            }
          }
          return pruned.size === current.size ? current : pruned
        })
      }
    } catch (error) {
      if (mountedRef.current && requestId === loadServersRequestIdRef.current) {
        toast.error(getRuntimeServerErrorMessage(error, 'Failed to load runtime servers.'))
      }
    } finally {
      if (mountedRef.current && requestId === loadServersRequestIdRef.current) {
        setLoadingServers(false)
      }
    }
  }, [mountedRef])

  const loadLocalProjects = useCallback(async (): Promise<void> => {
    const requestId = localProjectsRequestIdRef.current + 1
    localProjectsRequestIdRef.current = requestId
    setLocalProjects((current) => getProjectStateWithLoading(current))
    try {
      const repos = sortRuntimeServerProjects(await window.api.repos.list())
      if (mountedRef.current && requestId === localProjectsRequestIdRef.current) {
        setLocalProjects({ status: 'ready', repos, error: null })
      }
    } catch (error) {
      if (mountedRef.current && requestId === localProjectsRequestIdRef.current) {
        setLocalProjects({
          status: 'error',
          repos: [],
          error: getRuntimeServerErrorMessage(error, 'Failed to load local projects.')
        })
      }
    }
  }, [mountedRef])

  const loadRemoteProjects = useCallback(
    async (environmentId: string): Promise<void> => {
      const requestId = (remoteProjectsRequestIdsRef.current.get(environmentId) ?? 0) + 1
      remoteProjectsRequestIdsRef.current.set(environmentId, requestId)
      setRemoteProjectsByEnvironmentId((current) => {
        const next = new Map(current)
        next.set(environmentId, getProjectStateWithLoading(current.get(environmentId)))
        return next
      })
      try {
        const result = await callRuntimeRpc<{ repos: Repo[] }>(
          { kind: 'environment', environmentId },
          'repo.list',
          undefined,
          { timeoutMs: 15_000 }
        )
        if (
          mountedRef.current &&
          remoteProjectsRequestIdsRef.current.get(environmentId) === requestId
        ) {
          setRemoteProjectsByEnvironmentId((current) => {
            const next = new Map(current)
            next.set(environmentId, {
              status: 'ready',
              repos: sortRuntimeServerProjects(result.repos),
              error: null
            })
            return next
          })
        }
      } catch (error) {
        if (
          mountedRef.current &&
          remoteProjectsRequestIdsRef.current.get(environmentId) === requestId
        ) {
          setRemoteProjectsByEnvironmentId((current) => {
            const next = new Map(current)
            next.set(environmentId, {
              status: 'error',
              repos: [],
              error: getRuntimeServerErrorMessage(error, 'Failed to load remote projects.')
            })
            return next
          })
        }
      }
    },
    [mountedRef]
  )

  const loadProjects = useCallback(
    (serverId: string | null): void => {
      if (serverId === null) {
        void loadLocalProjects()
        return
      }
      void loadRemoteProjects(serverId)
    },
    [loadLocalProjects, loadRemoteProjects]
  )

  useEffect(() => {
    void loadServers()
  }, [loadServers])

  useEffect(() => {
    const activeId = activeRuntimeEnvironmentId?.trim() || null
    setExpandedServerIds((current) => {
      if (current.has(activeId)) {
        return current
      }
      const next = new Set(current)
      next.add(activeId)
      return next
    })
  }, [activeRuntimeEnvironmentId])

  useEffect(() => {
    for (const serverId of expandedServerIds) {
      const entry = entries.find((candidate) => candidate.id === serverId)
      if (entry && entry.projects.status === 'idle') {
        loadProjects(serverId)
      }
    }
  }, [entries, expandedServerIds, loadProjects])

  useEffect(() => {
    const activeId = activeRuntimeEnvironmentId?.trim() || null
    const projects: RuntimeServerProjectState = {
      status: 'ready',
      repos: sortRuntimeServerProjects(activeServerProjects),
      error: null
    }
    if (activeId === null) {
      setLocalProjects(projects)
      return
    }
    setRemoteProjectsByEnvironmentId((current) => {
      const next = new Map(current)
      next.set(activeId, projects)
      return next
    })
  }, [activeRuntimeEnvironmentId, activeServerProjects])

  const refreshServersAndProjects = useCallback((): void => {
    void loadServers()
    for (const serverId of expandedServerIds) {
      loadProjects(serverId)
    }
  }, [expandedServerIds, loadProjects, loadServers])

  const toggleExpanded = useCallback((serverId: string | null): void => {
    setExpandedServerIds((current) => {
      const next = new Set(current)
      if (next.has(serverId)) {
        next.delete(serverId)
      } else {
        next.add(serverId)
      }
      return next
    })
  }, [])

  const switchToServer = useCallback(
    async (serverId: string | null): Promise<boolean> => {
      if ((activeRuntimeEnvironmentId?.trim() || null) === serverId) {
        return true
      }
      return switchRuntimeEnvironment(serverId)
    },
    [activeRuntimeEnvironmentId, switchRuntimeEnvironment]
  )

  const handleSelectProject = useCallback(
    async (serverId: string | null, repo: Repo): Promise<void> => {
      const switched = await switchToServer(serverId)
      if (!switched) {
        return
      }
      setActiveRepo(repo.id)
      await fetchWorktrees(repo.id)
      const worktree = getRuntimeServerProjectActivationWorktree(
        useAppStore.getState().worktreesByRepo[repo.id] ?? []
      )
      if (!worktree) {
        toast.warning('No visible workspaces found for this project.')
        return
      }
      activateAndRevealWorktree(worktree.id, { sidebarRevealBehavior: 'smooth' })
    },
    [fetchWorktrees, setActiveRepo, switchToServer]
  )

  const openServerSettings = useCallback((): void => {
    openSettingsTarget({ pane: 'servers', repoId: null, sectionId: 'servers' })
    setActiveView('settings')
  }, [openSettingsTarget, setActiveView])

  return (
    <section className="mb-2 border-b border-sidebar-border/70 pb-2">
      <div className="flex h-8 items-center justify-between gap-2 px-2">
        <div className="min-w-0 pl-2 pr-0.5 text-xs font-semibold text-muted-foreground/80">
          Servers
        </div>
        <div className="flex items-center gap-0.5">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="size-5 text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground"
            aria-label="Manage remote servers"
            onClick={openServerSettings}
          >
            <Plus className="size-3" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="size-5 text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground"
            aria-label="Refresh runtime servers"
            onClick={refreshServersAndProjects}
            disabled={loadingServers}
          >
            {loadingServers ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <RefreshCw className="size-3" />
            )}
          </Button>
        </div>
      </div>
      <div className="py-1">
        {entries.map((entry) => {
          const expanded = expandedServerIds.has(entry.id)
          const active = entry.active
          const projectLabel = getRuntimeServerProjectLabel(entry.projects)
          return (
            <div key={entry.id ?? 'local'}>
              <div className="group flex h-7 items-center gap-1 px-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="size-5 shrink-0 text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground"
                  aria-label={`${expanded ? 'Collapse' : 'Expand'} ${entry.label} projects`}
                  onClick={() => toggleExpanded(entry.id)}
                >
                  <ChevronDown
                    className={cn('size-3.5 transition-transform', !expanded && '-rotate-90')}
                  />
                </Button>
                <button
                  type="button"
                  className={cn(
                    'flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1 text-left hover:bg-sidebar-accent',
                    active && 'bg-sidebar-accent text-sidebar-accent-foreground'
                  )}
                  aria-current={active ? 'true' : undefined}
                  onClick={() => void switchToServer(entry.id)}
                >
                  {entry.kind === 'local' ? (
                    <Monitor className="size-3.5 shrink-0 text-muted-foreground" />
                  ) : (
                    <Server className="size-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-[12px] font-medium">
                    {entry.label}
                  </span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {entry.projects.status === 'loading' ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : active ? (
                      'Active'
                    ) : (
                      projectLabel
                    )}
                  </span>
                </button>
              </div>
              {expanded ? (
                <>
                  {entry.kind === 'remote' ? (
                    <div
                      className={cn(
                        'truncate px-8 pb-1 text-[10px] text-muted-foreground',
                        entry.endpoint && 'font-mono'
                      )}
                    >
                      {entry.endpoint ?? 'No endpoint configured'}
                    </div>
                  ) : null}
                  <RuntimeServerProjects
                    entry={entry}
                    onSelectProject={(serverId, repo) => void handleSelectProject(serverId, repo)}
                  />
                </>
              ) : null}
            </div>
          )
        })}
        {environments.length === 0 ? (
          <button
            type="button"
            className="mt-0.5 flex h-6 w-full items-center gap-1.5 rounded-md px-8 text-left text-[11px] text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground"
            onClick={openServerSettings}
          >
            <Plus className="size-3" />
            <span>Add remote server...</span>
          </button>
        ) : null}
      </div>
    </section>
  )
}

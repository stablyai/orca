import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { useProjectHostSetupProjection } from '@/store/selectors'
import { activateAndRevealWorkspace } from '@/lib/worktree-activation'
import { ipcOrRuntimeTargetForHostId } from '@/runtime/runtime-client-target'
import { translate } from '@/i18n/i18n'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { getExecutionHostLabel, type ExecutionHostId } from '../../../../shared/execution-host'
import { MultiRepoWorkspaceError } from '../../../../shared/multi-repo-workspace'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { NewWorkspaceProjectOption } from '@/lib/new-workspace-project-options'
import type { WorkspaceCreateErrorDisplay } from '@/lib/workspace-create-error-format'
import { multiRepoWorkspaceSupportedOnTarget } from '@/store/slices/multi-repo-workspace/multi-repo-workspace-capability'
import { parseMultiRepoWorkspaceError } from '@/store/slices/multi-repo-workspace/multi-repo-workspace-transport'
import {
  buildMultiRepoCreateMembers,
  recordCreateInLastSet,
  resolveSameAsLastTime
} from './multi-repo-composer-model'
import { loadLastMultiRepoSet, saveLastMultiRepoSet } from './multi-repo-last-set-storage'
import { resolveSelectedProjects } from './resolve-project-setup-for-host'
import {
  countBlockedProjects,
  getMultiRepoCreateBlockedReason,
  getMultiRepoPrimaryActionLabel
} from './multi-repo-composer-status'
import type { ReadyProjectHostOption } from './new-workspace-composer-card-props'
import type { ProjectHostSetupOption } from '@/lib/project-host-setup-options'

export type UseMultiRepoComposerInput = {
  primaryProjectId: string | null
  projectOptions: readonly NewWorkspaceProjectOption[]
  projectHostSetupOptions: readonly ProjectHostSetupOption[]
  /** Host of the Run on selection; the workspace host never derives from the chosen projects. */
  hostId: ExecutionHostId | null
  name: string
  quickAgent: TuiAgent | null
  onPrimaryProjectChange: (projectId: string) => void
  onProjectHostSetupChange?: (setupId: string) => void
  onCreated: () => void
  /** True once the user dismissed the dialog; the created workspace then stays in the background. */
  isSubmissionCancelled?: () => boolean
}

export type MultiRepoComposerView = ReturnType<typeof useMultiRepoComposer>

export function useMultiRepoComposer({
  primaryProjectId,
  projectOptions,
  projectHostSetupOptions,
  hostId,
  name,
  quickAgent,
  onPrimaryProjectChange,
  onProjectHostSetupChange,
  onCreated,
  isSubmissionCancelled
}: UseMultiRepoComposerInput) {
  const { projects, setups } = useProjectHostSetupProjection()
  const createMultiRepoWorkspace = useAppStore((state) => state.createMultiRepoWorkspace)
  const [extraProjectIds, setExtraProjectIds] = useState<string[]>([])
  const [setupOverrides, setSetupOverrides] = useState<Record<string, string | undefined>>({})
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<WorkspaceCreateErrorDisplay | null>(null)
  // Keyed by the host and selection it described, so a change of either clears it without an effect.
  const [mixedHostsKey, setMixedHostsKey] = useState<string | null>(null)
  const [supported, setSupported] = useState<boolean | null>(null)
  const [lastSet] = useState(loadLastMultiRepoSet)
  const submittingRef = useRef(false)

  const selectedProjectIds = useMemo(
    () =>
      primaryProjectId
        ? [primaryProjectId, ...extraProjectIds.filter((id) => id !== primaryProjectId)]
        : [],
    [primaryProjectId, extraProjectIds]
  )
  const active = selectedProjectIds.length >= 2

  useEffect(() => {
    if (!hostId) {
      return
    }
    let cancelled = false
    const target = ipcOrRuntimeTargetForHostId(hostId)
    if (!target) {
      setSupported(false)
      return
    }
    void multiRepoWorkspaceSupportedOnTarget(target)
      .then((result) => !cancelled && setSupported(result))
      .catch(() => !cancelled && setSupported(false))
    return () => {
      cancelled = true
    }
  }, [hostId])

  const resolutions = useMemo(
    () =>
      hostId ? resolveSelectedProjects(selectedProjectIds, hostId, setups, setupOverrides) : [],
    [hostId, selectedProjectIds, setups, setupOverrides]
  )
  const blockedCount = countBlockedProjects(resolutions)
  const blockedReason = active ? getMultiRepoCreateBlockedReason(blockedCount) : null
  const hostLabel = hostId ? getExecutionHostLabel(hostId) : ''

  const sameAsLast = useMemo(
    () =>
      hostId && !active ? resolveSameAsLastTime(lastSet, selectedProjectIds, hostId, setups) : null,
    [active, hostId, lastSet, selectedProjectIds, setups]
  )

  const stateKey = `${hostId ?? ''}|${selectedProjectIds.join(',')}`
  const mixedHostsError = mixedHostsKey === stateKey

  const toggleProject = useCallback(
    (projectId: string): void => {
      if (projectId === primaryProjectId) {
        return
      }
      setExtraProjectIds((current) =>
        current.includes(projectId)
          ? current.filter((id) => id !== projectId)
          : [...current, projectId]
      )
    },
    [primaryProjectId]
  )

  const removeProject = useCallback(
    (projectId: string): void => {
      if (projectId === primaryProjectId) {
        // The first chip is the composer's own project; hand the role to the next one in line.
        const [next, ...rest] = extraProjectIds.filter((id) => id !== projectId)
        if (next) {
          setExtraProjectIds(rest)
          onPrimaryProjectChange(next)
        }
        return
      }
      setExtraProjectIds((current) => current.filter((id) => id !== projectId))
    },
    [extraProjectIds, onPrimaryProjectChange, primaryProjectId]
  )

  const chooseSetup = useCallback((projectId: string, setupId: string): void => {
    setSetupOverrides((current) => ({ ...current, [projectId]: setupId }))
  }, [])

  const readyOptionForHost = useCallback(
    (nextHostId: ExecutionHostId): ReadyProjectHostOption | undefined =>
      projectHostSetupOptions.find(
        (candidate): candidate is ReadyProjectHostOption =>
          candidate.kind === 'ready' && candidate.hostId === nextHostId
      ),
    [projectHostSetupOptions]
  )

  // Run on lists the primary project's setups, so switching only works where it has a ready one.
  const canUseHost = useCallback(
    (nextHostId: ExecutionHostId): boolean => readyOptionForHost(nextHostId) !== undefined,
    [readyOptionForHost]
  )

  const useHost = useCallback(
    (nextHostId: ExecutionHostId): void => {
      const option = readyOptionForHost(nextHostId)
      if (option) {
        onProjectHostSetupChange?.(option.id)
      }
    },
    [onProjectHostSetupChange, readyOptionForHost]
  )

  const applySameAsLast = useCallback((): void => {
    if (!sameAsLast) {
      return
    }
    const [first, ...rest] = sameAsLast
    setExtraProjectIds(rest)
    if (first && first !== primaryProjectId) {
      onPrimaryProjectChange(first)
    }
  }, [onPrimaryProjectChange, primaryProjectId, sameAsLast])

  const submit = useCallback(async (): Promise<void> => {
    if (!active || !hostId || blockedCount > 0 || submittingRef.current || !name.trim()) {
      return
    }
    const built = buildMultiRepoCreateMembers(
      selectedProjectIds,
      hostId,
      setups,
      setupOverrides,
      {}
    )
    if (!built.ok) {
      // The picker never offers a mixed selection; reaching here is a revalidation bug.
      setMixedHostsKey(built.reason === 'mixed_hosts' ? stateKey : null)
      return
    }
    submittingRef.current = true
    setCreating(true)
    setCreateError(null)
    setMixedHostsKey(null)
    try {
      const folderWorkspace = await createMultiRepoWorkspace({
        name: name.trim(),
        members: built.members,
        clientMutationId: createBrowserUuid(),
        ...(quickAgent ? { createdWithAgent: quickAgent } : {})
      })
      saveLastMultiRepoSet(recordCreateInLastSet(lastSet, selectedProjectIds))
      if (isSubmissionCancelled?.()) {
        return
      }
      activateAndRevealWorkspace(folderWorkspaceKey(folderWorkspace.id), {
        navigationIntent: 'user-open'
      })
      onCreated()
    } catch (error) {
      const parsed = parseMultiRepoWorkspaceError(error) ?? error
      if (parsed instanceof MultiRepoWorkspaceError && parsed.code === 'multi_repo_mixed_hosts') {
        setMixedHostsKey(stateKey)
      } else {
        setCreateError({
          title: translate(
            'auto.components.newWorkspace.multiRepo.createFailed',
            'Workspace creation failed'
          ),
          message: error instanceof Error ? error.message : String(error)
        })
      }
    } finally {
      submittingRef.current = false
      setCreating(false)
    }
  }, [
    active,
    blockedCount,
    createMultiRepoWorkspace,
    hostId,
    isSubmissionCancelled,
    lastSet,
    name,
    onCreated,
    quickAgent,
    selectedProjectIds,
    setupOverrides,
    setups,
    stateKey
  ])

  // Every selected project keeps a chip, even when the picker's options no longer list it (for
  // example its only setup sits on a host that is offline), so a blocked count always has a chip.
  const selectedProjects = useMemo(
    () =>
      selectedProjectIds.map((projectId) => {
        const option = projectOptions.find(
          (candidate) => candidate.kind === 'project' && candidate.projectId === projectId
        )
        const project = projects.find((candidate) => candidate.id === projectId)
        return {
          projectId,
          displayName: option?.displayName ?? project?.displayName ?? projectId,
          badgeColor: option?.badgeColor ?? project?.badgeColor ?? 'var(--muted-foreground)'
        }
      }),
    [projectOptions, projects, selectedProjectIds]
  )
  const creatableCount = selectedProjectIds.length - blockedCount

  return {
    active,
    supported,
    hostId,
    hostLabel,
    setups,
    selectedProjectIds,
    selectedProjects,
    resolutions,
    sameAsLast,
    sameAsLastLabel: sameAsLast
      ? sameAsLast
          .map((id) => projectOptions.find((o) => o.kind === 'project' && o.projectId === id))
          .flatMap((o) => (o ? [o.displayName] : []))
          .join(', ')
      : null,
    creating,
    createError,
    mixedHostsError,
    blockedCount,
    blockedReason,
    creatableCount,
    primaryActionLabel: getMultiRepoPrimaryActionLabel(creatableCount, creating),
    toggleProject,
    removeProject,
    chooseSetup,
    useHost,
    canUseHost,
    applySameAsLast,
    submit
  }
}

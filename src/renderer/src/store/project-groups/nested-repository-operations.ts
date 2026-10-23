import type { StateCreator } from 'zustand'
import { toast } from 'sonner'
import type { AppState } from '../types'
import type {
  NestedRepoScanResult,
  ProjectGroupImportResult
} from '../../../../shared/project-group-types'
import { callRuntimeRpc } from '../../runtime/runtime-rpc-client'
import {
  getRuntimeTargetHostId,
  ipcOrRuntimeTargetForHostId,
  runtimeTargetEnvironmentId,
  runtimeTargetForOwnerEnvironment
} from '../../runtime/runtime-client-target'
import { translate } from '@/i18n/i18n'
import type { RepoSlice } from '../repos/repo-state'
import { awaitRepoOwnerHostKnown } from '../repos/repo-owner-host-readiness'

export function normalizeNestedRepoScanResult(scan: NestedRepoScanResult): NestedRepoScanResult {
  return {
    ...scan,
    stopped: scan.stopped ?? false,
    maxDepth: scan.maxDepth ?? 3,
    maxRepos: scan.maxRepos ?? 100,
    timeoutMs: scan.timeoutMs ?? null
  }
}

export function createNestedRepositoryActions(
  set: Parameters<StateCreator<AppState>>[0],
  get: Parameters<StateCreator<AppState>>[1]
): Pick<RepoSlice, 'scanNestedRepos' | 'cancelNestedRepoScan' | 'importNestedRepos'> {
  return {
    scanNestedRepos: async (path, connectionId, controls) => {
      try {
        // Why: Add Project scans on the host the user picked; there is no row yet.
        const target = runtimeTargetForOwnerEnvironment(controls.runtimeEnvironmentId)
        if (target.kind === 'local') {
          const unsubscribe =
            controls.scanId && controls.onProgress
              ? window.api.projectGroups.onNestedScanProgress(({ scanId, scan }) => {
                  if (scanId === controls.scanId) {
                    controls.onProgress?.(normalizeNestedRepoScanResult(scan))
                  }
                })
              : undefined
          try {
            return normalizeNestedRepoScanResult(
              await window.api.projectGroups.scanNested({
                path,
                connectionId,
                scanId: controls.scanId
              })
            )
          } finally {
            unsubscribe?.()
          }
        }
        return normalizeNestedRepoScanResult(
          await callRuntimeRpc<NestedRepoScanResult>(
            target,
            'projectGroup.scanNested',
            { path },
            // Why: older runtime servers can't stream or cancel scans; keep a bounded failure path for large folders.
            { timeoutMs: 20_000 }
          )
        )
      } catch (err) {
        console.error('Failed to scan nested repos:', err)
        return null
      }
    },

    cancelNestedRepoScan: async (scanId, options) => {
      try {
        const target = runtimeTargetForOwnerEnvironment(options.runtimeEnvironmentId)
        if (target.kind !== 'local') {
          return false
        }
        return await window.api.projectGroups.cancelNestedScan({ scanId })
      } catch (err) {
        console.error('Failed to cancel nested repo scan:', err)
        return false
      }
    },

    importNestedRepos: async (args) => {
      try {
        const target = runtimeTargetForOwnerEnvironment(args.runtimeEnvironmentId)
        const result =
          target.kind === 'local'
            ? await window.api.projectGroups.importNested(args)
            : await callRuntimeRpc<ProjectGroupImportResult>(
                target,
                'projectGroup.importNested',
                {
                  parentPath: args.parentPath,
                  groupName: args.groupName,
                  projectPaths: args.projectPaths,
                  scanId: args.scanId,
                  mode: args.mode
                },
                { timeoutMs: 60_000 }
              )
        // Why: this app may answer from the server that now owns the folder (a WSL distro's); a
        // paired server's owner field names a host in its own catalog, so only ours is read.
        const answeredBy =
          (target.kind === 'local' && ipcOrRuntimeTargetForHostId(result.executionHostId)) || target
        const runtimeEnvironmentId = runtimeTargetEnvironmentId(answeredBy)
        if (runtimeEnvironmentId !== runtimeTargetEnvironmentId(target)) {
          await awaitRepoOwnerHostKnown(get, { executionHostId: result.executionHostId })
        }
        const catalogOptions = { runtimeEnvironmentId }
        await get().fetchProjectGroups(catalogOptions)
        await get().fetchFolderWorkspaces(catalogOptions)
        await (runtimeEnvironmentId
          ? get().fetchRuntimeEnvironmentRepos(runtimeEnvironmentId)
          : get().fetchRepos(catalogOptions))
        set({ folderWorkspacePathStatuses: {} })
        // Why only off this app: a local answer keeps main's result shape; a server's names its host.
        return answeredBy.kind === 'local'
          ? result
          : { ...result, executionHostId: getRuntimeTargetHostId(answeredBy) }
      } catch (err) {
        console.error('Failed to import nested repos:', err)
        toast.error(
          translate('auto.store.slices.repos.6d3318e813', 'Failed to import repositories'),
          {
            description: err instanceof Error ? err.message : String(err)
          }
        )
        return null
      }
    }
  }
}

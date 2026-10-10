import type { StateCreator } from 'zustand'
import { toast } from 'sonner'
import type { AppState } from '../types'
import type {
  NestedRepoScanResult,
  ProjectGroupImportResult
} from '../../../../shared/project-group-types'
import {
  callRuntimeRpc,
  getActiveRuntimeTarget,
  settingsForRuntimeOwner
} from '../../runtime/runtime-rpc-client'
import { translate } from '@/i18n/i18n'
import type { RepoSlice } from '../repos/repo-state'

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
        const target = getActiveRuntimeTarget(
          settingsForRuntimeOwner(get().settings, controls?.runtimeEnvironmentId)
        )
        if (target.kind === 'local') {
          const unsubscribe =
            controls?.scanId && controls.onProgress
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
                scanId: controls?.scanId
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
        const target = getActiveRuntimeTarget(
          settingsForRuntimeOwner(get().settings, options?.runtimeEnvironmentId)
        )
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
        const target = getActiveRuntimeTarget(
          settingsForRuntimeOwner(get().settings, args.runtimeEnvironmentId)
        )
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
        const catalogOptions =
          'runtimeEnvironmentId' in args
            ? { runtimeEnvironmentId: args.runtimeEnvironmentId }
            : undefined
        await get().fetchProjectGroups(catalogOptions)
        await get().fetchFolderWorkspaces(catalogOptions)
        await (args.runtimeEnvironmentId
          ? get().fetchRuntimeEnvironmentRepos(args.runtimeEnvironmentId)
          : get().fetchRepos(catalogOptions))
        set({ folderWorkspacePathStatuses: {} })
        return result
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

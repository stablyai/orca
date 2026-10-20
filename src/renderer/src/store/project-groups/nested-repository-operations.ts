import type { StateCreator } from 'zustand'
import { toast } from 'sonner'
import type { AppState } from '../types'
import type {
  NestedRepoScanResult,
  ProjectGroupImportResult
} from '../../../../shared/project-group-types'
import { callRuntimeRpc } from '../../runtime/runtime-rpc-client'
import { runtimeTargetForOwnerEnvironment } from '../../runtime/runtime-client-target'
import { resolveRuntimeRepositoryAddScriptRequest } from '../../runtime/runtime-repository-add-script'
import { offerRegistrationAddScript } from '../repos/repository-add-script-offer'
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
        const request = await resolveRuntimeRepositoryAddScriptRequest(target)
        const result =
          target.kind === 'local'
            ? await window.api.projectGroups.importNested({
                ...args,
                ...(request ? { repositoryAddScriptPreview: request } : {})
              })
            : await callRuntimeRpc<ProjectGroupImportResult>(
                target,
                'projectGroup.importNested',
                {
                  parentPath: args.parentPath,
                  groupName: args.groupName,
                  projectPaths: args.projectPaths,
                  scanId: args.scanId,
                  mode: args.mode,
                  ...(request ? { repositoryAddScriptPreview: request } : {})
                },
                { timeoutMs: 60_000 }
              )
        // Why before the catalog refreshes: a refresh may fail, but the offer was still earned.
        // Why repo ids: a selected linked worktree registers under its main worktree path.
        const importedRepoIds = new Set(
          result.projects.flatMap((project) =>
            project.status === 'imported' && project.projectId ? [project.projectId] : []
          )
        )
        for (const preview of result.repositoryAddScriptPreviews ?? []) {
          if (importedRepoIds.has(preview.repoId)) {
            offerRegistrationAddScript(request, preview.repoId, preview)
          }
        }
        const catalogOptions = { runtimeEnvironmentId: args.runtimeEnvironmentId }
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

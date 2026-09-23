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
import { parseWslUncPath } from '../../../../shared/wsl-paths'
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
        // Why: nested import bypasses addRepoPath, so pin the WSL runtime for
        // every newly imported project on \\wsl.localhost\<distro> here — not
        // just the first, which is all the caller's onGitRepoReady hook covers.
        // Why status === 'imported': re-importing must not silently overwrite a
        // runtime the user deliberately set on an already-known project.
        if (target.kind === 'local') {
          const projects = get().projects
          for (const entry of result.projects) {
            const repoId = entry.projectId
            const wslDistro = parseWslUncPath(entry.path)?.distro
            if (entry.status !== 'imported' || !repoId || !wslDistro) {
              continue
            }
            const pinned = projects.find((candidate) => candidate.sourceRepoIds.includes(repoId))
            if (pinned) {
              const pinnedOk = await get().updateProject(pinned.id, {
                localWindowsRuntimePreference: { kind: 'wsl', distro: wslDistro }
              })
              if (!pinnedOk) {
                console.warn(`Failed to pin WSL runtime (${wslDistro}) for project ${pinned.id}`)
              }
            }
          }
        }
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

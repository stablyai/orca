import type { PreloadApi } from '../../../../preload/api-types'
import type { NestedRepoScanResult } from '../../../../shared/project/groups/project-group-types'
import { callRuntimeResult } from '../runtime/client/web-runtime-calls'
import { noopUnsubscribe } from './web-storage'

/** Project groups are runtime-owned in Tauri; this keeps the renderer API Electron-compatible. */
export function createWebProjectGroupsApi(): NonNullable<Partial<PreloadApi>['projectGroups']> {
  return {
    list: async () =>
      (
        await callRuntimeResult<{
          groups: Awaited<ReturnType<PreloadApi['projectGroups']['list']>>
        }>('projectGroup.list')
      ).groups,
    create: async (args) =>
      (
        await callRuntimeResult<{
          group: Awaited<ReturnType<PreloadApi['projectGroups']['create']>>
        }>('projectGroup.create', args)
      ).group,
    update: async (args) =>
      (
        await callRuntimeResult<{
          group: Awaited<ReturnType<PreloadApi['projectGroups']['update']>>
        }>('projectGroup.update', args)
      ).group,
    delete: (args) => callRuntimeResult<boolean>('projectGroup.delete', args),
    moveProject: async (args) =>
      (
        await callRuntimeResult<{
          repo: Awaited<ReturnType<PreloadApi['projectGroups']['moveProject']>>
        }>('projectGroup.moveProject', {
          repo: args.projectId,
          groupId: args.groupId,
          order: args.order
        })
      ).repo,
    scanNested: (args) =>
      callRuntimeResult<NestedRepoScanResult>('projectGroup.scanNested', { path: args.path }),
    // The runtime scan is request/response based. Keep the Electron event surface harmless until
    // the runtime gains a progress stream for nested scans.
    cancelNestedScan: () => Promise.resolve(false),
    onNestedScanProgress: () => noopUnsubscribe,
    importNested: (args) =>
      callRuntimeResult('projectGroup.importNested', {
        parentPath: args.parentPath,
        groupName: args.groupName,
        projectPaths: args.projectPaths,
        mode: args.mode
      }),
    checkHooks: () => Promise.reject(new Error('unsupported')),
    updateMany: () => Promise.reject(new Error('unsupported'))
  }
}

import type { PreloadApi } from '../../../../preload/api-types'
import type { ProjectHostSetup } from '../../../../shared/project/project-types'
import { callRuntimeResult } from '../runtime/client/web-runtime-calls'

/** Project metadata is persisted by the local orcad runtime in Tauri. */
export function createWebProjectsApi(): NonNullable<Partial<PreloadApi>['projects']> {
  return {
    list: async () =>
      (
        await callRuntimeResult<{ projects: Awaited<ReturnType<PreloadApi['projects']['list']>> }>(
          'project.list'
        )
      ).projects,
    update: async (args) =>
      (
        await callRuntimeResult<{ project: Awaited<ReturnType<PreloadApi['projects']['update']>> }>(
          'project.update',
          args
        )
      ).project,
    listHostSetups: async () =>
      (await callRuntimeResult<{ setups: ProjectHostSetup[] }>('projectHostSetup.list')).setups,
    createHostSetup: async (args) =>
      (
        await callRuntimeResult<{
          result: Awaited<ReturnType<PreloadApi['projects']['createHostSetup']>>
        }>('projectHostSetup.create', args)
      ).result,
    setupExistingFolder: async (args) =>
      (
        await callRuntimeResult<{
          result: Awaited<ReturnType<PreloadApi['projects']['setupExistingFolder']>>
        }>('projectHostSetup.setupExistingFolder', args)
      ).result,
    updateHostSetup: async (args) =>
      (
        await callRuntimeResult<{
          result: Awaited<ReturnType<PreloadApi['projects']['updateHostSetup']>>
        }>('projectHostSetup.update', args)
      ).result,
    deleteHostSetup: async (args) =>
      (
        await callRuntimeResult<{
          result: Awaited<ReturnType<PreloadApi['projects']['deleteHostSetup']>>
        }>('projectHostSetup.delete', args)
      ).result
  }
}

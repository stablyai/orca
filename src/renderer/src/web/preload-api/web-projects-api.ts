import type { PreloadApi } from '../../../../preload/api-types'
import type { Project } from '../../../../shared/project-types'
import { callRuntimeResult } from './web-runtime-calls'

export function createWebProjectsApi(): Pick<PreloadApi['projects'], 'list' | 'update'> {
  return {
    list: async () => (await callRuntimeResult<{ projects: Project[] }>('project.list')).projects,
    update: async (args) =>
      (await callRuntimeResult<{ project: Project | null }>('project.update', args)).project
  }
}

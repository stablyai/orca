import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { githubProjectHost } from '../../../../shared/github/project-identity'
import type { GitHubProjectOwnerType } from '../../../../shared/github/project-types'
import type {
  ListAccessibleProjectsResult,
  ListProjectViewsResult,
  ResolveProjectRefResult
} from '../../../../shared/github/project-result-types'

type RuntimeSettings = Parameters<typeof getActiveRuntimeTarget>[0]

export function getProjectPickerRuntimeScope(settings: RuntimeSettings, host: string): string {
  const target = getActiveRuntimeTarget(settings)
  const runtimeScope = target.kind === 'environment' ? `runtime:${target.environmentId}` : 'local'
  return `${runtimeScope}\0${host.toLowerCase()}`
}

export function getProjectPickerBrowseHost(activeProject: { host?: string } | null): string {
  return githubProjectHost(activeProject?.host).toLowerCase()
}

export async function listAccessibleProjectsForRuntime(
  settings: RuntimeSettings,
  host: string
): Promise<ListAccessibleProjectsResult> {
  const target = getActiveRuntimeTarget(settings)
  const args = { host }
  return target.kind === 'environment'
    ? callRuntimeRpc<ListAccessibleProjectsResult>(target, 'github.project.listAccessible', args, {
        timeoutMs: 60_000
      })
    : window.api.gh.listAccessibleProjects(args)
}

export async function listProjectViewsForRuntime(
  settings: RuntimeSettings,
  args: {
    owner: string
    ownerType: GitHubProjectOwnerType
    projectNumber: number
    host?: string
  }
): Promise<ListProjectViewsResult> {
  const target = getActiveRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<ListProjectViewsResult>(target, 'github.project.listViews', args, {
        timeoutMs: 30_000
      })
    : window.api.gh.listProjectViews(args)
}

export async function resolveProjectRefForRuntime(
  settings: RuntimeSettings,
  input: string,
  host?: string
): Promise<ResolveProjectRefResult> {
  const target = getActiveRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<ResolveProjectRefResult>(
        target,
        'github.project.resolveRef',
        { input, ...(host ? { host } : {}) },
        { timeoutMs: 30_000 }
      )
    : window.api.gh.resolveProjectRef({ input, ...(host ? { host } : {}) })
}

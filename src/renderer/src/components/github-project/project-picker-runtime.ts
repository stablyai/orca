import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { githubProjectHost } from '../../../../shared/github/project-identity'
import type { GitHubProjectOwnerType } from '../../../../shared/github/project-types'
import type {
  ListAccessibleProjectsResult,
  ListProjectViewsResult,
  ResolveProjectRefResult
} from '../../../../shared/github/project-result-types'

/** `target` is the board's row-less source host, never the focused server. */
export function getProjectPickerRuntimeScope(target: RuntimeClientTarget, host: string): string {
  const runtimeScope = target.kind === 'environment' ? `runtime:${target.environmentId}` : 'local'
  return `${runtimeScope}\0${host.toLowerCase()}`
}

export function getProjectPickerBrowseHost(activeProject: { host?: string } | null): string {
  return githubProjectHost(activeProject?.host).toLowerCase()
}

export async function listAccessibleProjectsForRuntime(
  target: RuntimeClientTarget,
  host: string
): Promise<ListAccessibleProjectsResult> {
  const args = { host }
  return target.kind === 'environment'
    ? callRuntimeRpc<ListAccessibleProjectsResult>(target, 'github.project.listAccessible', args, {
        timeoutMs: 60_000
      })
    : window.api.gh.listAccessibleProjects(args)
}

export async function listProjectViewsForRuntime(
  target: RuntimeClientTarget,
  args: {
    owner: string
    ownerType: GitHubProjectOwnerType
    projectNumber: number
    host?: string
  }
): Promise<ListProjectViewsResult> {
  return target.kind === 'environment'
    ? callRuntimeRpc<ListProjectViewsResult>(target, 'github.project.listViews', args, {
        timeoutMs: 30_000
      })
    : window.api.gh.listProjectViews(args)
}

export async function resolveProjectRefForRuntime(
  target: RuntimeClientTarget,
  input: string,
  host?: string
): Promise<ResolveProjectRefResult> {
  return target.kind === 'environment'
    ? callRuntimeRpc<ResolveProjectRefResult>(
        target,
        'github.project.resolveRef',
        { input, ...(host ? { host } : {}) },
        { timeoutMs: 30_000 }
      )
    : window.api.gh.resolveProjectRef({ input, ...(host ? { host } : {}) })
}

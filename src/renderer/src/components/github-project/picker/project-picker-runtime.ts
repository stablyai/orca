import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { githubProjectHost } from '../../../../../shared/github/projects/project-identity'
import type { GitHubProjectOwnerType } from '../../../../../shared/github/projects/project-types'
import type {
  ListAccessibleProjectsResult,
  ListProjectViewsResult,
  ResolveProjectRefResult
} from '../../../../../shared/github/projects/project-result-types'

/** `target` is the board's row-less source host, never the focused server. */
export function getProjectPickerRuntimeScope(
  target: RuntimeClientTarget,
  host: string | undefined
): string {
  const runtimeScope = target.kind === 'environment' ? `runtime:${target.environmentId}` : 'local'
  return `${runtimeScope}\0${host?.toLowerCase() ?? ''}`
}

/** Without a saved project, omit the host so gh uses its own default host (e.g. its only GHES login). */
export function getProjectPickerBrowseHost(
  activeProject: { host?: string } | null
): string | undefined {
  return activeProject ? githubProjectHost(activeProject.host).toLowerCase() : undefined
}

/** `wake`: a click, which may start the stopped WSL distro gh lives in (E9); mount effects omit it. */
type PickerCallOptions = { wake?: boolean }

function wakeArg(options: PickerCallOptions): { wakeWslDistro?: true } {
  return options.wake ? { wakeWslDistro: true } : {}
}

export async function listAccessibleProjectsForRuntime(
  target: RuntimeClientTarget,
  host: string | undefined,
  options: PickerCallOptions = {}
): Promise<ListAccessibleProjectsResult> {
  const args = host ? { host } : {}
  return target.kind === 'environment'
    ? callRuntimeRpc<ListAccessibleProjectsResult>(target, 'github.project.listAccessible', args, {
        timeoutMs: 60_000
      })
    : window.api.gh.listAccessibleProjects({ ...args, ...wakeArg(options) })
}

export async function listProjectViewsForRuntime(
  target: RuntimeClientTarget,
  args: {
    owner: string
    ownerType: GitHubProjectOwnerType
    projectNumber: number
    host?: string
  },
  options: PickerCallOptions = {}
): Promise<ListProjectViewsResult> {
  return target.kind === 'environment'
    ? callRuntimeRpc<ListProjectViewsResult>(target, 'github.project.listViews', args, {
        timeoutMs: 30_000
      })
    : window.api.gh.listProjectViews({ ...args, ...wakeArg(options) })
}

export async function resolveProjectRefForRuntime(
  target: RuntimeClientTarget,
  input: string,
  host?: string,
  options: PickerCallOptions = {}
): Promise<ResolveProjectRefResult> {
  return target.kind === 'environment'
    ? callRuntimeRpc<ResolveProjectRefResult>(
        target,
        'github.project.resolveRef',
        { input, ...(host ? { host } : {}) },
        { timeoutMs: 30_000 }
      )
    : window.api.gh.resolveProjectRef({ input, ...(host ? { host } : {}), ...wakeArg(options) })
}

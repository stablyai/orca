import type { AppState } from '@/store'
import type { TuiAgent } from '../../../shared/tui-agent'

export type SourceControlAgentDetectionTarget =
  | { kind: 'unavailable' }
  | { kind: 'ssh'; connectionId: string }
  | { kind: 'runtime'; environmentId: string }
  | { kind: 'local'; worktreeId?: string | null }

export type SourceControlAgentDetectionStore = Pick<
  AppState,
  'ensureDetectedAgents' | 'ensureRemoteDetectedAgents' | 'ensureRuntimeDetectedAgents'
>

export function resolveSourceControlAgentDetectionTarget(args: {
  worktreeId?: string | null
  connectionId?: string | null
  runtimeEnvironmentId?: string | null
}): SourceControlAgentDetectionTarget {
  if (typeof args.connectionId === 'string') {
    return { kind: 'ssh', connectionId: args.connectionId }
  }
  if (args.runtimeEnvironmentId) {
    return { kind: 'runtime', environmentId: args.runtimeEnvironmentId }
  }
  // Why: undefined SSH is unhydrated remote ownership — never fall through to local PATH.
  if (args.worktreeId && args.connectionId === undefined) {
    return { kind: 'unavailable' }
  }
  return { kind: 'local', worktreeId: args.worktreeId }
}

export async function ensureSourceControlDetectedAgents(
  target: SourceControlAgentDetectionTarget,
  store: SourceControlAgentDetectionStore
): Promise<TuiAgent[]> {
  switch (target.kind) {
    case 'unavailable':
      return []
    case 'ssh':
      return store.ensureRemoteDetectedAgents(target.connectionId)
    case 'runtime':
      return store.ensureRuntimeDetectedAgents(target.environmentId)
    case 'local':
      return store.ensureDetectedAgents(target.worktreeId)
  }
}

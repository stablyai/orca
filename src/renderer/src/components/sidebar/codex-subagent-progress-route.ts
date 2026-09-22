import type { CodexSubagentProgressHostAuthority } from './codex-subagent-progress-host-authority'

export type CodexSubagentProgressRoute =
  | { kind: 'readable'; runtimeEnvironmentId: string | null }
  | { kind: 'unavailable'; reason: 'unknown-owner' | 'legacy-ssh' | 'runtime-owner-missing' }

export function resolveCodexSubagentProgressRoute(
  authority: CodexSubagentProgressHostAuthority
): CodexSubagentProgressRoute {
  switch (authority.kind) {
    case 'local':
      return { kind: 'readable', runtimeEnvironmentId: null }
    case 'runtime':
      return { kind: 'readable', runtimeEnvironmentId: authority.environmentId }
    case 'legacy-ssh':
      return { kind: 'unavailable', reason: 'legacy-ssh' }
    case 'unknown':
      return { kind: 'unavailable', reason: authority.reason }
  }
}

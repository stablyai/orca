import { CapabilityProbeCache } from './capability-probe-cache'

// Why: suppress hot-loop failures while still detecting an in-place Git
// upgrade during a long Orca session without requiring a restart.
export const GIT_CAPABILITY_RETRY_INTERVAL_MS = 30 * 60_000

export type GitCapability =
  | 'fetch-no-write-fetch-head'
  | 'for-each-ref-exclude'
  | 'merge-tree-merge-base'
  | 'merge-tree-write-tree'
  | 'push-auto-setup-remote'
  | 'rev-parse-path-format'
  | 'worktree-list-z'

export const GIT_PUSH_SET_UPSTREAM_GUIDANCE = 'git push --set-upstream <remote> <branch>'

export function isPushAutoSetupRemoteApplicable(pushDefault: string | undefined): boolean {
  const value = pushDefault?.trim()
  return value === undefined || value === 'simple' || value === 'upstream' || value === 'current'
}

export async function supportsPushAutoSetupRemote(
  capabilities: GitCapabilityCache,
  readConfigVariables: () => Promise<string>
): Promise<boolean> {
  if (capabilities.isKnownSupported('push-auto-setup-remote')) {
    return true
  }
  return capabilities.runWithFallback(
    'push-auto-setup-remote',
    async () => {
      const supported = new Set((await readConfigVariables()).split(/\r?\n/)).has(
        'push.autoSetupRemote'
      )
      if (!supported) {
        capabilities.rememberUnsupported('push-auto-setup-remote')
      }
      return supported
    },
    async () => false,
    () => false
  )
}

export class GitCapabilityCache extends CapabilityProbeCache<GitCapability> {
  constructor() {
    super(GIT_CAPABILITY_RETRY_INTERVAL_MS)
  }
}

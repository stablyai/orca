export type AutomationTargetAvailability =
  | {
      canRunNow: true
      reason: 'available'
      message: null
    }
  | {
      canRunNow: false
      reason:
        | 'missing-project'
        | 'missing-project-host-setup'
        | 'project-host-setup-not-ready'
        | 'missing-workspace'
        | 'host-mismatch'
        | 'unsupported-host'
        | 'runtime-checking'
        | 'runtime-unavailable'
        | 'runtime-update-required'
        | 'ssh-auth-needed'
        | 'ssh-unavailable'
        | 'ssh-connecting'
        | 'source-auth-needed'
        | 'source-tool-unavailable'
        | 'source-provider-unsupported'
        | 'source-host-unavailable'
      message: string
    }

export function unavailable(
  reason: Exclude<AutomationTargetAvailability['reason'], 'available'>,
  message: string
): AutomationTargetAvailability {
  return { canRunNow: false, reason, message }
}

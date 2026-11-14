/** What the user can do when managed-server setup stops on a deferral code. */
export type SshHostServerSetupRemedy =
  | 'retry'
  | 'free-host-space'
  | 'stop-unmanaged-runtime'
  | 'see-details'

// A later connect clears these by itself: another run held the host, or its daemon didn't answer a count.
const RETRYABLE_SETUP_CODES: ReadonlySet<string> = new Set([
  'orcad_activation_fence_busy',
  'orcad_update_terminal_census_unavailable'
])

export function sshHostServerSetupRemedy(code: string | undefined): SshHostServerSetupRemedy {
  // No code: a thrown setup error, or a host that predates published codes.
  if (code === undefined || RETRYABLE_SETUP_CODES.has(code)) {
    return 'retry'
  }
  switch (code) {
    case 'orcad_snapshot_space_insufficient':
      return 'free-host-space'
    case 'orcad_initial_runtime_live':
      return 'stop-unmanaged-runtime'
    default:
      return 'see-details'
  }
}

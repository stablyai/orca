// Without -b, dead network mounts leave unkillable stat helpers per scan; -w hides the resulting warnings.
// Use only without file arguments: -b rejects queries such as -U <path> and +D <dir>.
export const LSOF_NONBLOCKING_ARGS = ['-b', '-w'] as const

import { z } from 'zod'

// Why enum-only (design D6): these rows size the old-glibc and no-runtime fleet. A hostname,
// user, path or raw loader error would identify a machine, so none of them may appear.

/** Minors between the oldest glibc any rung admits and a generous ceiling; the rest bucket. */
const GLIBC_MINORS = [
  '17',
  '18',
  '19',
  '20',
  '21',
  '22',
  '23',
  '24',
  '25',
  '26',
  '27',
  '28',
  '29',
  '30',
  '31',
  '32',
  '33',
  '34',
  '35',
  '36',
  '37',
  '38',
  '39',
  '40',
  '41',
  '42'
] as const
export const SSH_RUNTIME_GLIBC_MINOR_VALUES = [
  'none',
  'below_17',
  ...GLIBC_MINORS,
  'above_42'
] as const

const HOST_NODE_MAJORS = [
  '18',
  '19',
  '20',
  '21',
  '22',
  '23',
  '24',
  '25',
  '26',
  '27',
  '28',
  '29',
  '30'
] as const
export const SSH_RUNTIME_HOST_NODE_MAJOR_VALUES = [...HOST_NODE_MAJORS, 'above_30'] as const

export const SSH_RUNTIME_REFUSAL_VALUES = [
  'none',
  'noexec',
  'missing_lib',
  'libc_floor',
  'illegal_instruction',
  'wrong_libc',
  'security_software',
  'windows_host_unsupported',
  'target_unresolved',
  'artifacts_unavailable',
  'runtime_unavailable',
  'host_node_missing',
  'install_failed'
] as const

export const SSH_RUNTIME_DURATION_BUCKETS = ['lt_5s', '5s_15s', '15s_60s', 'gte_60s'] as const

export const SSH_RUNTIME_OUTCOME_VALUES = ['resolved', 'unverifiable', 'failed'] as const

export const sshRemoteRuntimeResolvedSchema = z
  .object({
    rung: z.enum(['a', 'b', 'c', 'd', 'legacy']),
    host_os: z.enum(['linux', 'darwin', 'win32']),
    host_arch: z.enum(['x64', 'arm64']),
    host_libc: z.enum(['glibc', 'musl', 'none', 'unknown']),
    glibc_minor: z.enum(SSH_RUNTIME_GLIBC_MINOR_VALUES),
    first_refusal: z.enum(SSH_RUNTIME_REFUSAL_VALUES),
    self_test: z.enum(['passed', 'refused', 'failed', 'unverifiable', 'not_run']),
    runtime_transfer: z.enum(['uploaded', 'cached', 'none']),
    // Rung C only: the one rung whose behavior depends on the host's own Node.
    host_node_major: z.enum(SSH_RUNTIME_HOST_NODE_MAJOR_VALUES).optional(),
    duration_bucket: z.enum(SSH_RUNTIME_DURATION_BUCKETS),
    // Why: a connect whose self-test was unverifiable or failed settles no rung; without this the
    // event only ever saw successes.
    outcome: z.enum(SSH_RUNTIME_OUTCOME_VALUES)
  })
  .strict()

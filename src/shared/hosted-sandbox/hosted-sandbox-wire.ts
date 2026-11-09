// Wire contract between the desktop and the Orca sandbox control plane (cloud/apps/sandbox-control).
// The Worker's tests parse its responses with these schemas, so either side drifting fails a test.
import { z } from 'zod'

// Billing sells exactly these; larger boxes need a Vercel Enterprise plan.
export const HOSTED_SANDBOX_MACHINE_SIZES = ['standard', 'large'] as const
export type HostedSandboxMachineSize = (typeof HOSTED_SANDBOX_MACHINE_SIZES)[number]

export const HOSTED_SANDBOX_STATUSES = [
  'creating',
  'running',
  'suspending',
  'suspended',
  'resuming',
  'destroying',
  'destroyed',
  'failed',
  'archived'
] as const
export type HostedSandboxStatus = (typeof HOSTED_SANDBOX_STATUSES)[number]

export const HOSTED_SANDBOX_ERROR_CODES = [
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'entitlement_denied',
  'invalid_request',
  'invalid_json',
  'billing_unavailable',
  'provider_unavailable',
  'not_configured',
  'internal_error'
] as const
export type HostedSandboxErrorCode = (typeof HOSTED_SANDBOX_ERROR_CODES)[number]

const Id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_.:-]+$/)
const Millis = z.number().int().nonnegative()

export const HostedSandboxSessionSchema = z
  .object({
    id: Id,
    startedAt: Millis,
    deadlineAt: Millis,
    leaseExpiresAt: Millis
  })
  .strict()

export const HostedSandboxViewSchema = z
  .object({
    id: Id,
    workspaceId: Id,
    status: z.enum(HOSTED_SANDBOX_STATUSES),
    machineSize: z.enum(HOSTED_SANDBOX_MACHINE_SIZES),
    region: z.string().min(1).max(32),
    session: HostedSandboxSessionSchema.nullable(),
    createdAt: Millis,
    /** Org environment build this workspace booted from; null/absent for the plain image. */
    environmentBuildId: Id.nullable().optional()
  })
  .strict()
export type HostedSandboxView = z.infer<typeof HostedSandboxViewSchema>

export const HostedSandboxConnectionSchema = z
  .object({
    type: z.literal('orca-server'),
    pairingCode: z.string().min(1).max(8192),
    projectRoot: z.string().startsWith('/').max(4096)
  })
  .strict()

export const HostedSandboxCreateRequestSchema = z
  .object({
    workspaceId: Id,
    machineSize: z.enum(HOSTED_SANDBOX_MACHINE_SIZES),
    region: z
      .string()
      .regex(/^[a-z]{3}[0-9]$/)
      .optional(),
    repo: z
      .object({
        url: z.url({ protocol: /^https$/ }).max(2048),
        ref: z.string().min(1).max(255).optional()
      })
      .strict()
      .optional(),
    /** Boot from exactly this org environment build (rollback testing, pinned projects). */
    environmentBuildId: z
      .string()
      .regex(/^bld_[0-9a-f]{8,40}$/)
      .optional(),
    /** Default true: boot from the active build of the org environment that lists the repo. */
    useEnvironment: z.boolean().optional()
  })
  .strict()
export type HostedSandboxCreateRequest = z.infer<typeof HostedSandboxCreateRequestSchema>

export const HostedSandboxLeaseRequestSchema = z
  .object({
    extendMs: z
      .number()
      .int()
      .min(60_000)
      .max(60 * 60_000)
  })
  .strict()

/** create, resume and rollover: the environment is up and orcad is ready to pair. */
export const HostedSandboxReadyResponseSchema = z
  .object({ sandbox: HostedSandboxViewSchema, connection: HostedSandboxConnectionSchema })
  .strict()
export type HostedSandboxReadyResponse = z.infer<typeof HostedSandboxReadyResponseSchema>

export const HostedSandboxStatusResponseSchema = z
  .object({ sandbox: HostedSandboxViewSchema })
  .strict()

export const HostedSandboxListResponseSchema = z
  .object({ sandboxes: z.array(HostedSandboxViewSchema).max(1000) })
  .strict()

/** `POST /v1/sandboxes/:id/desktop`: the remote desktop's port on the VM's loopback, never a public route. */
export const HostedSandboxDesktopResponseSchema = z.object({
  desktop: z.object({
    port: z.number().int().min(1024).max(65_535),
    path: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
    password: z.string().regex(/^[A-Za-z0-9]{8}$/)
  })
})

export type HostedSandboxDesktop = z.infer<typeof HostedSandboxDesktopResponseSchema>['desktop']

export const HostedSandboxErrorResponseSchema = z
  .object({
    error: z.enum(HOSTED_SANDBOX_ERROR_CODES),
    reason: z.string().max(64).optional()
  })
  .strict()

/** Every wake source (open, message, SSH, preview) answers in this shape. */
export const HOSTED_WAKE_STATES = ['ready', 'waking', 'archived', 'failed', 'not_found'] as const
export const HostedWakeResponseSchema = z
  .object({
    state: z.enum(HOSTED_WAKE_STATES),
    endpoint: z.string().startsWith('wss://').max(2048).nullable(),
    readyAt: Millis.nullable(),
    sandboxId: Id.nullable()
  })
  .strict()
export type HostedWakeResponse = z.infer<typeof HostedWakeResponseSchema>

export const HOSTED_WORKSPACE_STATES = [
  'provisioning',
  'sleeping',
  'waking',
  'ready',
  'unresponsive',
  'stopping',
  'archived',
  'failed'
] as const
export type HostedWorkspaceState = (typeof HOSTED_WORKSPACE_STATES)[number]

const Bytes = z.number().int().nonnegative()
export const HostedVmMetricsSchema = z
  .object({
    cpuPercent: z.number().int().min(0).max(100),
    cpus: z.number().int().min(1),
    load1: z.number().min(0),
    memTotalBytes: Bytes,
    memUsedBytes: Bytes,
    diskTotalBytes: Bytes,
    diskUsedBytes: Bytes,
    uptimeSeconds: z.number().int().nonnegative(),
    oomKills: z.number().int().nonnegative(),
    lastOomVictim: z.string().max(64).nullable(),
    orcadAlive: z.boolean()
  })
  .strict()
export type HostedVmMetrics = z.infer<typeof HostedVmMetricsSchema>

export const HostedWorkspaceStatusSchema = z
  .object({
    state: z.enum(HOSTED_WORKSPACE_STATES),
    metrics: HostedVmMetricsSchema.nullable(),
    uptimeMs: Millis.nullable(),
    usage: z
      .object({
        totalMs: Millis,
        centsPerHour: z.number().int().nonnegative(),
        costCents: z.number().int().nonnegative()
      })
      .strict(),
    archive: z.object({ archivedAt: Millis, expiresAt: Millis.nullable() }).strict().nullable(),
    checkedAt: Millis
  })
  .strict()
export type HostedWorkspaceStatus = z.infer<typeof HostedWorkspaceStatusSchema>

export const HostedWorkspaceStatusResponseSchema = z
  .object({ sandbox: HostedSandboxViewSchema, status: HostedWorkspaceStatusSchema })
  .strict()

const ArchiveCommit = z
  .object({
    sha: z.string().max(64),
    author: z.string().max(120),
    at: z.number(),
    subject: z.string().max(300)
  })
  .strict()
export const HostedArchiveCheckoutSchema = z
  .object({
    path: z.string().max(4096),
    branch: z.string().max(255).nullable(),
    head: z.string().max(64).nullable(),
    upstream: z.string().max(255).nullable(),
    ahead: z.number().int().nullable(),
    behind: z.number().int().nullable(),
    commits: z.array(ArchiveCommit).max(20),
    changes: z
      .array(z.object({ status: z.string().max(2), path: z.string().max(1024) }).strict())
      .max(300),
    diffStat: z.string().max(200).nullable(),
    fileCount: z.number().int().nonnegative(),
    files: z.array(z.string().max(1024)).max(2000)
  })
  .strict()
export type HostedArchiveCheckout = z.infer<typeof HostedArchiveCheckoutSchema>
export const HostedArchivePullRequestSchema = z
  .object({
    number: z.number().int().positive(),
    title: z.string().max(300),
    state: z.enum(['open', 'closed', 'merged', 'draft']),
    url: z.url({ protocol: /^https$/ }).max(2048),
    branch: z.string().max(255).optional()
  })
  .strict()
export type HostedArchivePullRequest = z.infer<typeof HostedArchivePullRequestSchema>

export const HostedArchiveRequestSchema = z
  .object({
    pullRequests: z.array(HostedArchivePullRequestSchema).max(50).optional(),
    checkouts: z.array(HostedArchiveCheckoutSchema).max(20).optional()
  })
  .strict()
export type HostedArchiveRequest = z.infer<typeof HostedArchiveRequestSchema>

export const HostedArchiveResponseSchema = z
  .object({
    archive: z
      .object({
        capturedAt: Millis,
        source: z.enum(['vm', 'client', 'none']),
        metadata: z
          .object({
            checkouts: z.array(HostedArchiveCheckoutSchema).max(20),
            pullRequests: z.array(HostedArchivePullRequestSchema).max(50).optional()
          })
          .strict()
      })
      .strict()
      .nullable()
  })
  .strict()
export type HostedArchiveResponse = z.infer<typeof HostedArchiveResponseSchema>

/** ed25519 only, one line, a plain comment: nothing sshd would read as key options. */
export const HOSTED_SANDBOX_SSH_PUBLIC_KEY =
  /^ssh-ed25519 [A-Za-z0-9+/]{68} [A-Za-z0-9@._:+-]{1,200}$/

/** POST (install) and DELETE (revoke) /v1/sandboxes/:id/ssh-keys. */
export const HostedSandboxSshKeyRequestSchema = z
  .object({ publicKey: z.string().regex(HOSTED_SANDBOX_SSH_PUBLIC_KEY) })
  .strict()

/** The VM's loopback sshd: the desktop pins `hostKey` instead of trusting it on first use. */
export const HostedSandboxSshAccessResponseSchema = z
  .object({
    ssh: z
      .object({
        port: z.number().int().min(1).max(65535),
        user: z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/),
        hostKey: z.string().regex(/^ssh-ed25519 [A-Za-z0-9+/]{68}$/)
      })
      .strict()
  })
  .strict()
export type HostedSandboxSshAccess = z.infer<typeof HostedSandboxSshAccessResponseSchema>['ssh']

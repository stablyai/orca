import { createHash, randomBytes } from 'node:crypto'
import type { TuiAgent } from './tui-agent'

export const NO_GITHUB_AUTHORITY_POLICY = 'no-github-authority/v1' as const
export const WORKER_AUTHORITY_POLICY_RUNTIME_CAPABILITY =
  'orchestration.worker-authority-policy.v1' as const
export const WORKER_AUTHORITY_POLICY_SCHEMA_VERSION = 'worker_policy_capability/1' as const
export const WORKER_AUTHORITY_ATTESTATION_SCHEMA_VERSION = 'worker_authority_attestation/1' as const

const POLICY_SEMANTICS = [
  NO_GITHUB_AUTHORITY_POLICY,
  'fresh-home',
  'deny-host-home',
  'deny-git-credentials',
  'deny-ssh-agents',
  'deny-os-credential-store',
  'deny-authenticated-connectors',
  'dedicated-worker-model-credential'
].join('\n')

export const NO_GITHUB_AUTHORITY_POLICY_DIGEST = `sha256:${createHash('sha256')
  .update(POLICY_SEMANTICS)
  .digest('hex')}` as const

export const WORKER_AUTHORITY_CAPABILITY_TTL_MS = 5 * 60 * 1_000

export type WorkerAuthoritySetupPolicy = 'run' | 'skip' | 'inherit' | 'not_applicable'

export type WorkerAuthorityPolicyCapability = {
  schemaVersion: typeof WORKER_AUTHORITY_POLICY_SCHEMA_VERSION
  policy: typeof NO_GITHUB_AUTHORITY_POLICY
  policyDigest: typeof NO_GITHUB_AUTHORITY_POLICY_DIGEST
  runtimeId: string
  hostId: string
  environmentId: string
  agentId: TuiAgent
  worktreeId: string
  setupPolicy: WorkerAuthoritySetupPolicy
  setupCoverage: ['setup', 'terminal', 'agent', 'descendants', 'connectors']
  enforcement: 'available'
  capabilityRef: `sha256:${string}`
  expiresAt: string
}

export type WorkerAuthorityIsolationAttestation = {
  schemaVersion: typeof WORKER_AUTHORITY_ATTESTATION_SCHEMA_VERSION
  policy: typeof NO_GITHUB_AUTHORITY_POLICY
  policyDigest: typeof NO_GITHUB_AUTHORITY_POLICY_DIGEST
  capabilityRef: `sha256:${string}`
  runtimeId: string
  hostId: string
  environmentId: string
  runId: string
  taskId: string
  dispatchId: string
  agentId: TuiAgent
  worktreeId: string
  setupPolicy: WorkerAuthoritySetupPolicy
  executionBoundary: 'vm_backed_container'
  imageDigest: string
  enforcement: 'enforced'
  coveredSurfaces: {
    environment: 'denied'
    hostFilesAndConfig: 'denied'
    credentialHelpersAndAgents: 'denied'
    osCredentialStore: 'denied'
    accountsAndConnectors: 'denied'
    setupAndDescendants: 'covered'
    modelProviderChannel: 'dedicated_worker_credential'
  }
  proofRef: `sha256:${string}`
}

export type WorkerAuthorityIsolationLaunchRequest = {
  schemaVersion: 'worker_authority_launch/1'
  policy: typeof NO_GITHUB_AUTHORITY_POLICY
  policyDigest: typeof NO_GITHUB_AUTHORITY_POLICY_DIGEST
  capabilityRef: `sha256:${string}`
  dispatchId: string
  worktreeId: string
  setupPolicy: WorkerAuthoritySetupPolicy
  imageDigest: string
  lifecycleDirectory: string
  lifecycleBinding: `sha256:${string}`
}

export function createWorkerAuthorityIsolationAttestation(args: {
  request: WorkerAuthorityIsolationLaunchRequest
  runtimeId: string
  runId: string
  taskId: string
  dispatchId: string
  agentId: TuiAgent
  processIncarnation: string
}): WorkerAuthorityIsolationAttestation {
  const proofRef = `sha256:${createHash('sha256')
    .update(
      JSON.stringify({
        policyDigest: args.request.policyDigest,
        capabilityRef: args.request.capabilityRef,
        runtimeId: args.runtimeId,
        runId: args.runId,
        taskId: args.taskId,
        dispatchId: args.dispatchId,
        agentId: args.agentId,
        worktreeId: args.request.worktreeId,
        setupPolicy: args.request.setupPolicy,
        executionBoundary: 'vm_backed_container',
        imageDigest: args.request.imageDigest,
        processIncarnation: args.processIncarnation
      })
    )
    .digest('hex')}` as const
  return {
    schemaVersion: WORKER_AUTHORITY_ATTESTATION_SCHEMA_VERSION,
    policy: args.request.policy,
    policyDigest: args.request.policyDigest,
    capabilityRef: args.request.capabilityRef,
    runtimeId: args.runtimeId,
    hostId: 'local',
    environmentId: 'local',
    runId: args.runId,
    taskId: args.taskId,
    dispatchId: args.dispatchId,
    agentId: args.agentId,
    worktreeId: args.request.worktreeId,
    setupPolicy: args.request.setupPolicy,
    executionBoundary: 'vm_backed_container',
    imageDigest: args.request.imageDigest,
    enforcement: 'enforced',
    coveredSurfaces: {
      environment: 'denied',
      hostFilesAndConfig: 'denied',
      credentialHelpersAndAgents: 'denied',
      osCredentialStore: 'denied',
      accountsAndConnectors: 'denied',
      setupAndDescendants: 'covered',
      modelProviderChannel: 'dedicated_worker_credential'
    },
    proofRef
  }
}

type CapabilityRecord = WorkerAuthorityPolicyCapability & { consumed: boolean }

const capabilities = new Map<string, CapabilityRecord>()

export function isNoGithubAuthorityPolicySupported(args: {
  agent: TuiAgent
  platform?: NodeJS.Platform
  processOwnerSupportsIsolation?: boolean
}): boolean {
  const platform = args.platform ?? process.platform
  return (
    args.processOwnerSupportsIsolation === true && platform === 'darwin' && args.agent === 'codex'
  )
}

export function issueWorkerAuthorityPolicyCapability(args: {
  runtimeId: string
  agentId: TuiAgent
  worktreeId: string
  setupPolicy: WorkerAuthoritySetupPolicy
  now?: number
}): WorkerAuthorityPolicyCapability {
  const now = args.now ?? Date.now()
  pruneCapabilities(now)
  const capability: WorkerAuthorityPolicyCapability = {
    schemaVersion: WORKER_AUTHORITY_POLICY_SCHEMA_VERSION,
    policy: NO_GITHUB_AUTHORITY_POLICY,
    policyDigest: NO_GITHUB_AUTHORITY_POLICY_DIGEST,
    runtimeId: args.runtimeId,
    hostId: 'local',
    environmentId: 'local',
    agentId: args.agentId,
    worktreeId: args.worktreeId,
    setupPolicy: args.setupPolicy,
    setupCoverage: ['setup', 'terminal', 'agent', 'descendants', 'connectors'],
    enforcement: 'available',
    capabilityRef: `sha256:${randomBytes(32).toString('hex')}`,
    expiresAt: new Date(now + WORKER_AUTHORITY_CAPABILITY_TTL_MS).toISOString()
  }
  capabilities.set(capability.capabilityRef, { ...capability, consumed: false })
  return capability
}

export function consumeWorkerAuthorityPolicyCapability(args: {
  capabilityRef: string
  policy: string
  runtimeId: string
  agentId: TuiAgent
  worktreeId: string
  setupPolicy: WorkerAuthoritySetupPolicy
  now?: number
}): WorkerAuthorityPolicyCapability | null {
  const now = args.now ?? Date.now()
  pruneCapabilities(now)
  const record = capabilities.get(args.capabilityRef)
  if (
    !record ||
    record.consumed ||
    record.policy !== args.policy ||
    record.runtimeId !== args.runtimeId ||
    record.agentId !== args.agentId ||
    record.worktreeId !== args.worktreeId ||
    record.setupPolicy !== args.setupPolicy ||
    Date.parse(record.expiresAt) <= now
  ) {
    return null
  }
  record.consumed = true
  return { ...record }
}

function pruneCapabilities(now: number): void {
  for (const [ref, capability] of capabilities) {
    if (Date.parse(capability.expiresAt) <= now) {
      capabilities.delete(ref)
    }
  }
}

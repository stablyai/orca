import { z } from 'zod'
import { OptionalFiniteNumber, OptionalString, requiredString } from './rpc-param-primitives'
import { OptionalWorkerLaunchPreference } from './orchestration-worker-start-params'
import { WorkerRoleName } from '../orchestration-worker-roles'

export const FederationAttachStartParams = z.object({
  /** Omitted by v1.4.198 coordinators; the worker host then mints a stub home Run. */
  runId: OptionalString,
  dispatchId: requiredString('Missing Dispatch ID'),
  taskId: requiredString('Missing Task ID'),
  taskSpec: requiredString('Missing Task spec'),
  /** Depth stamped by the Run home; omitted by older clients and defaults to 1. */
  depth: z.number().int().min(1).optional(),
  protocolVersion: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  worktree: requiredString('Missing remote worktree selector'),
  name: OptionalString,
  repo: OptionalString,
  baseBranch: OptionalString,
  displayName: OptionalString,
  displayNameKind: z.enum(['generated', 'user']).optional(),
  comment: OptionalString,
  setup: z.enum(['run', 'skip', 'inherit']).optional(),
  setupSource: z.enum(['explicit_request', 'orchestration_default']).optional(),
  terminal: OptionalString,
  agent: OptionalString,
  role: WorkerRoleName.optional(),
  model: OptionalWorkerLaunchPreference,
  effort: OptionalWorkerLaunchPreference,
  fastMode: z.boolean().optional(),
  timeoutMs: OptionalFiniteNumber,
  devMode: z.boolean().optional()
})

export const FederationWorkerLaunchParams = FederationAttachStartParams.omit({
  runId: true,
  dispatchId: true,
  taskId: true,
  taskSpec: true,
  depth: true,
  protocolVersion: true,
  timeoutMs: true,
  devMode: true
})

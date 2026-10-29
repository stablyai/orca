import { getDefaultWorkspaceSession } from './constants'
import { workspaceSessionStateSchema } from './workspace-session-schema'
import { collectSalvageDrops } from './zod-salvage'
import { isSessionMapField } from './session-change-set'
import type { WorkspaceSessionPatch } from './workspace-session-state-types'
import { WORKSPACE_SESSION_FIELD_OWNERSHIP } from './workspace-session-host-field-ownership'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function validateSessionPatch(patch: WorkspaceSessionPatch): void {
  if (!isRecord(patch)) {
    throw new Error('Invalid session patch')
  }
  for (const field of Object.keys(patch)) {
    if (
      !Object.hasOwn(WORKSPACE_SESSION_FIELD_OWNERSHIP, field) &&
      !['mapDeltas', 'membershipDeltas', 'clearFields', 'expectedPartitionGeneration'].includes(
        field
      )
    ) {
      throw new Error(`Unknown session patch field: ${field}`)
    }
  }
  const named: Record<string, unknown> = { ...getDefaultWorkspaceSession() }
  for (const [field, value] of Object.entries(patch)) {
    if (Object.hasOwn(WORKSPACE_SESSION_FIELD_OWNERSHIP, field)) {
      named[field] = value
    }
  }
  if (
    patch.expectedPartitionGeneration !== undefined &&
    typeof patch.expectedPartitionGeneration !== 'string'
  ) {
    throw new Error('Invalid session generation')
  }
  if (patch.mapDeltas !== undefined) {
    if (!isRecord(patch.mapDeltas)) {
      throw new Error('Invalid session map deltas')
    }
    for (const [field, delta] of Object.entries(patch.mapDeltas)) {
      if (!isSessionMapField(field) || !isRecord(delta) || Object.hasOwn(patch, field)) {
        throw new Error(`Invalid session delta: ${field}`)
      }
      if (Object.keys(delta).some((key) => key !== 'set' && key !== 'remove')) {
        throw new Error(`Unknown session delta operation: ${field}`)
      }
      if (delta.set !== undefined && !isRecord(delta.set)) {
        throw new Error(`Invalid session delta values: ${field}`)
      }
      if (
        delta.remove !== undefined &&
        (!Array.isArray(delta.remove) || !delta.remove.every((key) => typeof key === 'string'))
      ) {
        throw new Error(`Invalid session removals: ${field}`)
      }
      if (delta.set !== undefined) {
        named[field] = delta.set
      }
      for (const key of delta.remove ?? []) {
        if (Object.hasOwn(delta.set ?? {}, key)) {
          throw new Error(`Conflicting session edit: ${field}`)
        }
      }
    }
  }
  if (patch.membershipDeltas !== undefined) {
    if (!isRecord(patch.membershipDeltas)) {
      throw new Error('Invalid session membership deltas')
    }
    for (const [field, delta] of Object.entries(patch.membershipDeltas)) {
      if (
        (field !== 'activeWorktreeIdsOnShutdown' && field !== 'activeConnectionIdsAtShutdown') ||
        !isRecord(delta) ||
        Object.hasOwn(patch, field)
      ) {
        throw new Error(`Invalid session membership: ${field}`)
      }
      if (Object.keys(delta).some((key) => key !== 'add' && key !== 'remove')) {
        throw new Error(`Unknown session membership operation: ${field}`)
      }
      for (const operation of ['add', 'remove'] as const) {
        if (
          delta[operation] !== undefined &&
          (!Array.isArray(delta[operation]) ||
            !delta[operation].every((id) => typeof id === 'string'))
        ) {
          throw new Error(`Invalid session membership values: ${field}`)
        }
      }
    }
  }
  if (
    patch.clearFields !== undefined &&
    (!Array.isArray(patch.clearFields) ||
      !patch.clearFields.every(
        (field) =>
          typeof field === 'string' &&
          Object.hasOwn(WORKSPACE_SESSION_FIELD_OWNERSHIP, field) &&
          !Object.hasOwn(patch, field) &&
          !Object.hasOwn(patch.mapDeltas ?? {}, field) &&
          !Object.hasOwn(patch.membershipDeltas ?? {}, field)
      ))
  ) {
    throw new Error('Invalid session clear fields')
  }
  const parsed = collectSalvageDrops(() => workspaceSessionStateSchema.safeParse(named))
  if (!parsed.value.success || parsed.droppedCount) {
    throw new Error(`Invalid session values: ${parsed.droppedPaths[0] ?? 'session'}`)
  }
}

import { translate } from '@/i18n/i18n'
import { parseExecutionHostId, toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import type { SessionMemory, WorktreeMemory } from '../../../../shared/process-stats-types'
import type { RuntimeHostResourceSample } from './resource-usage-merge-types'

export type RuntimeHostResourceResult =
  | { status: 'sampled'; worktrees: WorktreeMemory[] }
  // Why: a server that never answered is unverifiable, so the panel names it instead of showing it idle.
  | { status: 'unreachable' }
  | { status: 'update-required' }

export type RuntimeHostResourceCall = (environmentId: string) => Promise<unknown>

/** Paired servers that host at least one of this client's projects or folder workspaces. */
export function collectRuntimeResourceEnvironmentIds(
  hostIds: Iterable<string | null | undefined>
): string[] {
  const environmentIds = new Set<string>()
  for (const hostId of hostIds) {
    const parsed = parseExecutionHostId(hostId)
    if (parsed?.kind === 'runtime') {
      environmentIds.add(parsed.environmentId)
    }
  }
  return [...environmentIds].sort()
}

export async function readRuntimeHostResources(
  environmentId: string,
  call: RuntimeHostResourceCall
): Promise<RuntimeHostResourceResult> {
  try {
    const worktrees = parseSnapshotWorktrees(await call(environmentId))
    return worktrees ? { status: 'sampled', worktrees } : { status: 'update-required' }
  } catch (error) {
    return hasErrorCode(error, 'method_not_found')
      ? { status: 'update-required' }
      : { status: 'unreachable' }
  }
}

export function toRuntimeHostResourceSamples(
  results: Readonly<Record<string, RuntimeHostResourceResult>>,
  hostLabel: (environmentId: string) => string
): RuntimeHostResourceSample[] {
  const samples: RuntimeHostResourceSample[] = []
  for (const [environmentId, result] of Object.entries(results)) {
    if (result.status === 'sampled') {
      samples.push({
        hostId: toRuntimeExecutionHostId(environmentId),
        hostLabel: hostLabel(environmentId),
        worktrees: result.worktrees
      })
    }
  }
  return samples
}

export function getRuntimeHostResourceNotices(
  results: Readonly<Record<string, RuntimeHostResourceResult>>,
  hostLabel: (environmentId: string) => string
): string[] {
  return Object.entries(results).flatMap(([environmentId, result]) => {
    if (result.status === 'unreachable') {
      return [
        translate(
          'auto.components.status.bar.ResourceUsageStatusSegment.8a0472ab54',
          "Couldn't reach {{value0}}; its resources are unknown.",
          { value0: hostLabel(environmentId) }
        )
      ]
    }
    if (result.status === 'update-required') {
      return [
        translate(
          'auto.components.status.bar.ResourceUsageStatusSegment.1ea066b73f',
          'Update {{value0}} to see its resources.',
          { value0: hostLabel(environmentId) }
        )
      ]
    }
    return []
  })
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

// Why: servers ship independently; keep well-formed rows and drop the rest rather than trusting the shape.
function parseSnapshotWorktrees(value: unknown): WorktreeMemory[] | null {
  if (!isRecord(value) || !Array.isArray(value.worktrees)) {
    return null
  }
  const worktrees: WorktreeMemory[] = []
  for (const row of value.worktrees) {
    const cpu = isRecord(row) ? finiteNumber(row.cpu) : null
    const memory = isRecord(row) ? finiteNumber(row.memory) : null
    if (
      !isRecord(row) ||
      typeof row.worktreeId !== 'string' ||
      typeof row.repoId !== 'string' ||
      cpu === null ||
      memory === null
    ) {
      continue
    }
    worktrees.push({
      worktreeId: row.worktreeId,
      worktreeName: typeof row.worktreeName === 'string' ? row.worktreeName : row.worktreeId,
      repoId: row.repoId,
      repoName: typeof row.repoName === 'string' ? row.repoName : row.repoId,
      cpu,
      memory,
      sessions: Array.isArray(row.sessions) ? row.sessions.flatMap(parseSessionMemory) : [],
      history: Array.isArray(row.history)
        ? row.history.flatMap((sample) => finiteNumber(sample) ?? [])
        : []
    })
  }
  return worktrees
}

function parseSessionMemory(value: unknown): SessionMemory[] {
  if (!isRecord(value) || typeof value.sessionId !== 'string') {
    return []
  }
  const cpu = finiteNumber(value.cpu)
  const memory = finiteNumber(value.memory)
  if (cpu === null || memory === null) {
    return []
  }
  return [
    {
      sessionId: value.sessionId,
      paneKey: typeof value.paneKey === 'string' ? value.paneKey : null,
      pid: finiteNumber(value.pid) ?? 0,
      cpu,
      memory
    }
  ]
}

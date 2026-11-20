import { isTuiAgent } from '../../agent-launch/catalog/tui-agent-config'
import type { ZotzAgentQueueSnapshot } from './zotz-agent-queue-snapshot'
import type { ZotzMemoryPressure } from './zotz-memory-pressure'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isPressure(value: unknown): value is ZotzMemoryPressure {
  return value === 'ok' || value === 'elevated' || value === 'critical'
}

function normalizeMemory(value: unknown): ZotzAgentQueueSnapshot['memory'] {
  if (!isRecord(value)) {
    return null
  }
  const { totalBytes, availableBytes, pressure, minFreeBytes, perAgentMaxBytes, sampledAt } = value
  if (
    isFiniteNumber(totalBytes) &&
    isFiniteNumber(availableBytes) &&
    isPressure(pressure) &&
    isFiniteNumber(minFreeBytes) &&
    isFiniteNumber(perAgentMaxBytes) &&
    isFiniteNumber(sampledAt)
  ) {
    return { totalBytes, availableBytes, pressure, minFreeBytes, perAgentMaxBytes, sampledAt }
  }
  return null
}

type RunningAgent = ZotzAgentQueueSnapshot['running'][number]
type DoneAgent = ZotzAgentQueueSnapshot['done'][number]
type QueuedTask = ZotzAgentQueueSnapshot['queued'][number]
type CanceledLaunch = ZotzAgentQueueSnapshot['canceled'][number]

function isAgentState(value: unknown): value is RunningAgent['state'] {
  return value === 'working' || value === 'blocked' || value === 'waiting' || value === 'done'
}

function isPriority(value: unknown): value is QueuedTask['priority'] {
  return value === 'automation' || value === 'manual' || value === 'remote'
}

function isWaitReason(value: unknown): value is QueuedTask['waitReason'] {
  return value === 'memory' || value === 'pressure' || value === null
}

function isWorktreeId(value: unknown): value is string | null {
  return typeof value === 'string' || value === null
}

function parseRunning(value: unknown): RunningAgent | null {
  if (!isRecord(value)) {
    return null
  }
  const { paneKey, agent, state, worktreeId, bytes, peakBytes, startedAt } = value
  return typeof paneKey === 'string' &&
    typeof agent === 'string' &&
    isTuiAgent(agent) &&
    isAgentState(state) &&
    isWorktreeId(worktreeId) &&
    isFiniteNumber(bytes) &&
    isFiniteNumber(peakBytes) &&
    isFiniteNumber(startedAt)
    ? { paneKey, agent, state, worktreeId, bytes, peakBytes, startedAt }
    : null
}

function parseDone(value: unknown): DoneAgent | null {
  if (!isRecord(value)) {
    return null
  }
  const { paneKey, agent, worktreeId, peakBytes, startedAt, endedAt } = value
  return typeof paneKey === 'string' &&
    typeof agent === 'string' &&
    isTuiAgent(agent) &&
    isWorktreeId(worktreeId) &&
    isFiniteNumber(peakBytes) &&
    isFiniteNumber(startedAt) &&
    isFiniteNumber(endedAt)
    ? { paneKey, agent, worktreeId, peakBytes, startedAt, endedAt }
    : null
}

function parseQueued(value: unknown): QueuedTask | null {
  if (!isRecord(value)) {
    return null
  }
  const { id, agent, priority, label, estimatedBytes, enqueuedAt, position, waitReason } = value
  return typeof id === 'string' &&
    typeof agent === 'string' &&
    isTuiAgent(agent) &&
    isPriority(priority) &&
    typeof label === 'string' &&
    isFiniteNumber(estimatedBytes) &&
    isFiniteNumber(enqueuedAt) &&
    isFiniteNumber(position) &&
    isWaitReason(waitReason)
    ? { id, agent, priority, label, estimatedBytes, enqueuedAt, position, waitReason }
    : null
}

function parseCanceled(value: unknown): CanceledLaunch | null {
  if (!isRecord(value)) {
    return null
  }
  const { id, agent, label, canceledAt } = value
  return typeof id === 'string' &&
    typeof agent === 'string' &&
    isTuiAgent(agent) &&
    typeof label === 'string' &&
    isFiniteNumber(canceledAt)
    ? { id, agent, label, canceledAt }
    : null
}

function parseEach<T>(value: unknown, parse: (entry: unknown) => T | null): T[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.flatMap((entry) => {
    const parsed = parse(entry)
    return parsed ? [parsed] : []
  })
}

/** What another machine sent is not trusted: a missing or malformed field falls back to empty instead of breaking the window. */
export function normalizeRemoteZotzAgentQueueSnapshot(
  value: unknown
): ZotzAgentQueueSnapshot | null {
  if (!isRecord(value)) {
    return null
  }
  return {
    memory: normalizeMemory(value.memory),
    running: parseEach(value.running, parseRunning),
    done: parseEach(value.done, parseDone),
    queued: parseEach(value.queued, parseQueued),
    canceled: parseEach(value.canceled, parseCanceled)
  }
}

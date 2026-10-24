import {
  clearStructuredReadResumeCache,
  forgetStructuredReadResume
} from './structured-agent-session-read-resume-cache'
import type { AgentJournalCursor } from '../../../../shared/agent-session-journal-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { StructuredAgentSessionReadOwner } from './structured-agent-session-read-owner'

const observations = new Map<string, { cursor: AgentJournalCursor; observationKey: string }>()
export function retainStructuredReadObservation(
  key: string,
  observation: { cursor: AgentJournalCursor; observationKey: string }
): void {
  observations.set(key, observation)
}
export function readStructuredReadObservation(key: string) {
  return observations.get(key)
}

const owners = new Map<string, StructuredAgentSessionReadOwner>()
export function structuredReadOwnerKey(sessionId: string, target: RuntimeClientTarget): string {
  return `${target.kind === 'local' ? 'local' : `environment:${target.environmentId}`}:${sessionId}`
}
export function findStructuredAgentSessionReadOwner(
  sessionId: string,
  target: RuntimeClientTarget
): StructuredAgentSessionReadOwner | undefined {
  return owners.get(structuredReadOwnerKey(sessionId, target))
}
/** A closed chat no longer needs an unmounted create page or an active reader. */
export function retireStructuredAgentSessionReadOwner(
  sessionId: string,
  target: RuntimeClientTarget
): void {
  const key = structuredReadOwnerKey(sessionId, target)
  const owner = owners.get(key)
  owners.delete(key)
  observations.delete(key)
  forgetStructuredReadResume(key)
  try {
    owner?.dispose()
  } catch (error) {
    console.warn('[native-chat] retiring a conversation reader failed', error)
  }
}
export function getOrCreateStructuredReadOwner(
  key: string,
  create: () => StructuredAgentSessionReadOwner
): StructuredAgentSessionReadOwner {
  const existing = owners.get(key)
  if (existing) {
    return existing
  }
  const owner = create()
  owners.set(key, owner)
  return owner
}
/** A held owner names its key again once its last holders released it, never over a live one. */
export function adoptStructuredReadOwner(
  key: string,
  owner: StructuredAgentSessionReadOwner
): void {
  if (!owners.has(key)) {
    forgetStructuredReadResume(key)
    owners.set(key, owner)
  }
}
export function forgetStructuredReadOwner(
  key: string,
  owner: StructuredAgentSessionReadOwner
): boolean {
  if (owners.get(key) !== owner) {
    return false
  }
  owners.delete(key)
  return true
}
export function resetStructuredAgentSessionReadOwnersForTests(): void {
  for (const owner of owners.values()) {
    owner.dispose()
  }
  owners.clear()
  observations.clear()
  clearStructuredReadResumeCache()
}

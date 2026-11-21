import { AGENT_STATUS_STALE_AFTER_MS } from '../../../agent-status/contracts/agent-status-freshness'
import type { AgentHookEventPayload } from '../../listener-event'
import type { HookListenerState } from '../../listener-state'
import { RolloutReadBatch } from '../codex/codex-rollout-async-reads'
import { buildAntigravityFoldedStatusPayload } from './antigravity-parent-status'
import { ANTIGRAVITY_PARENT_WAKE_GRACE_MS } from './antigravity-event-rules'
import type { AntigravityLaunchResult } from './antigravity-launch-results'
import { applyAntigravityLaunchResults } from './antigravity-launch-state'
import {
  antigravityMetadataUnchanged,
  readAntigravityChildMetadata,
  readAntigravitySwarmMembers,
  type AntigravityChildMetadata,
  type AntigravityChildTranscriptTail
} from './antigravity-brain-metadata'
import {
  applyAntigravityLeadModel,
  antigravityRootTranscriptPath,
  antigravityTranscriptFilePath,
  readAntigravityChildTranscriptTail,
  type AntigravityLeadModelFence
} from './antigravity-child-transcript'
import {
  verifyAntigravityChild,
  retireAntigravityChild,
  antigravityHasPendingLaunch,
  antigravityHelpersSettled,
  type AntigravityPaneChildState,
  type TrackedAntigravityChild
} from './antigravity-pane-state'

export function antigravityDiscoveryEndsAt(pane: AntigravityPaneChildState): number {
  return (
    Math.max(pane.leadObservedAt ?? 0, pane.discoveryObservedAt ?? 0) + AGENT_STATUS_STALE_AFTER_MS
  )
}

function discoversAntigravityChildren(pane: AntigravityPaneChildState): boolean {
  return (
    Date.now() < antigravityDiscoveryEndsAt(pane) &&
    (pane.rootStop !== 'idle' || antigravityHasPendingLaunch(pane))
  )
}

function canReadLeadModel(pane: AntigravityPaneChildState): boolean {
  return (
    (pane.leadModel === undefined || pane.leadModelSince !== undefined) &&
    Date.now() < (pane.leadObservedAt ?? 0) + AGENT_STATUS_STALE_AFTER_MS
  )
}

export function antigravityIdleGraceEndsAt(pane: AntigravityPaneChildState): number | undefined {
  if (pane.rootStop === 'idle' && pane.helpersIdleAt !== undefined) {
    return pane.helpersIdleAt + ANTIGRAVITY_PARENT_WAKE_GRACE_MS
  }
  return undefined
}

export function hasAntigravityPollWork(
  state: HookListenerState,
  event: AgentHookEventPayload
): boolean {
  const pane = state.antigravityChildWorkByPaneKey.get(event.paneKey)
  if (event.payload.state === 'done' && !pane?.verifiedChildren.size) {
    return false
  }
  return Boolean(
    pane &&
    (pane.dirty ||
      antigravityIdleGraceEndsAt(pane) !== undefined ||
      (pane.rootBrainDir &&
        (pane.verifiedChildren.size > 0 ||
          (discoversAntigravityChildren(pane) &&
            (pane.children.size > 0 || pane.pendingLaunches.size > 0)) ||
          (canReadLeadModel(pane) && pane.rootStop !== 'idle' && pane.rootConversationId))))
  )
}
/** Every child is proven with a fixed model and nothing waits on proof, a spawn or the lead's model. */
export function isAntigravityPollSettled(state: HookListenerState, paneKey: string): boolean {
  const pane = state.antigravityChildWorkByPaneKey.get(paneKey)
  if (!pane || !canProbeAntigravityMetadata(pane)) {
    return false
  }
  const readsModels = Date.now() < antigravityDiscoveryEndsAt(pane)
  for (const id of pane.verifiedChildren) {
    if (!isAntigravityChildSettled(pane.children.get(id), readsModels)) {
      return false
    }
  }
  return true
}

function canProbeAntigravityMetadata(pane: AntigravityPaneChildState): boolean {
  return (
    !pane.dirty &&
    (Date.now() >= antigravityDiscoveryEndsAt(pane) ||
      (!antigravityHasPendingLaunch(pane) && pane.children.size === pane.verifiedChildren.size)) &&
    (pane.rootStop === 'idle' || !canReadLeadModel(pane))
  )
}

function isAntigravityChildSettled(
  child: TrackedAntigravityChild | undefined,
  readsModels: boolean
): boolean {
  return Boolean(child && !child.stopped && (!readsModels || (!child.modelAuto && child.model)))
}

export type AntigravityTranscriptPollReads = {
  pane: AntigravityPaneChildState
  cache: AntigravityPaneChildState['brainCache']
  nextPoll?: 'backlog' | 'unchanged'
  children?: {
    child: TrackedAntigravityChild
    revision: number
    metadata?: AntigravityChildMetadata
    model?: string
  }[]
  leadTail?: AntigravityChildTranscriptTail
  leadModelFence?: AntigravityLeadModelFence
  launchResults?: ReadonlyMap<number, AntigravityLaunchResult | null>
}
export async function readAntigravityTranscriptPoll(
  state: HookListenerState,
  paneKey: string,
  live: () => boolean = () => true
): Promise<AntigravityTranscriptPollReads | undefined> {
  const pane = state.antigravityChildWorkByPaneKey.get(paneKey)
  if (!pane || !live()) {
    return undefined
  }
  const cache = pane.brainCache
  const wanted = (): boolean =>
    live() && state.antigravityChildWorkByPaneKey.get(paneKey) === pane && pane.brainCache === cache
  const result: AntigravityTranscriptPollReads = { pane, cache }
  const brain = pane.rootBrainDir
  if (!brain) {
    return result
  }
  const readsModels = Date.now() < antigravityDiscoveryEndsAt(pane)
  if (
    canProbeAntigravityMetadata(pane) &&
    (await antigravityMetadataUnchanged(
      brain,
      cache,
      pane.verifiedChildren,
      (id) => isAntigravityChildSettled(pane.children.get(id), readsModels),
      wanted
    )) &&
    canProbeAntigravityMetadata(pane)
  ) {
    result.nextPoll = 'unchanged'
    return result
  }
  if (!wanted()) {
    return undefined
  }
  const children: NonNullable<AntigravityTranscriptPollReads['children']> = []
  result.children = children
  const discovering = discoversAntigravityChildren(pane)
  const candidates: { child: TrackedAntigravityChild; revision: number }[] = []
  for (const child of pane.children.values()) {
    if (discovering || pane.verifiedChildren.has(child.id)) {
      candidates.push({ child, revision: child.revision })
    }
  }
  const members = candidates.length
    ? await readAntigravitySwarmMembers(brain, cache, wanted)
    : undefined
  for (const { child, revision } of candidates) {
    const current = (): boolean =>
      wanted() && pane.children.get(child.id) === child && child.revision === revision
    if (!wanted()) {
      return undefined
    }
    if (!current()) {
      continue
    }
    const member = members?.get(child.id)
    const descriptor = await readAntigravityChildMetadata(brain, child.id, cache, current)
    const metadata =
      member && descriptor?.killed && !member.killed
        ? { ...member, killed: true }
        : (member ?? descriptor)
    if (!current()) {
      continue
    }
    const batch = new RolloutReadBatch(current)
    try {
      const model =
        Date.now() < antigravityDiscoveryEndsAt(pane) &&
        (child.model === undefined || child.modelAuto) &&
        metadata &&
        !metadata.model &&
        !metadata.killed &&
        !child.stopped
          ? (await readAntigravityChildTranscriptTail(brain, child.id, cache, batch))?.model
          : undefined
      if (current()) {
        children.push({ child, revision, metadata, model })
      }
      const transcript = antigravityTranscriptFilePath(brain, child.id)
      // An automatic model can change mid-run, so its transcript keeps its read position.
      if (model && !child.modelAuto && transcript) {
        cache.transcripts.delete(transcript)
      }
    } finally {
      batch.release()
    }
  }
  const readsModel = canReadLeadModel(pane) && pane.rootStop !== 'idle'
  const rootId = pane.rootConversationId
  const rootPath = antigravityRootTranscriptPath(pane)
  if (
    rootId &&
    rootPath &&
    wanted() &&
    (readsModel || (discovering && pane.pendingLaunches.size))
  ) {
    const fence = {
      leadModel: pane.leadModel,
      leadModelSince: pane.leadModelSince,
      leadModelFromStep: pane.leadModelFromStep
    }
    const batch = new RolloutReadBatch(wanted)
    try {
      const tail = await readAntigravityChildTranscriptTail(brain, rootId, cache, batch, {
        path: rootPath,
        pendingSteps: pane.pendingLaunches,
        readsModel
      })
      result.leadTail = tail
      result.leadModelFence = readsModel ? fence : undefined
      result.launchResults = tail?.launchResults
      if (tail?.hasMore) {
        result.nextPoll = 'backlog'
      }
    } finally {
      batch.release()
    }
  }
  return wanted() ? result : undefined
}
export function pollAntigravityTranscriptStatus(
  state: HookListenerState,
  original: AgentHookEventPayload,
  reads: AntigravityTranscriptPollReads | undefined
): AgentHookEventPayload | undefined {
  const pane = state.antigravityChildWorkByPaneKey.get(original.paneKey)
  if (!reads || pane !== reads.pane || pane.brainCache !== reads.cache) {
    return undefined
  }
  if (reads.nextPoll === 'unchanged') {
    return original
  }
  applyAntigravityLeadModel(pane, reads.leadTail, reads.leadModelFence)
  const now = Date.now()
  if (reads.launchResults) {
    applyAntigravityLaunchResults(pane, reads.launchResults, now)
  }
  const proven: string[] = []
  for (const { child, revision, metadata, model } of reads.children ?? []) {
    if (pane.children.get(child.id) !== child || child.revision !== revision) {
      continue
    }
    if (metadata?.killed && pane.verifiedChildren.has(child.id)) {
      retireAntigravityChild(pane, child.id)
    } else if (metadata) {
      verifyAntigravityChild(pane, child.id)
      child.description = metadata.description
      child.agentType = metadata.agentType
      child.model =
        metadata.model ?? (child.modelAuto ? (model ?? child.model) : (child.model ?? model))
      // A killed descriptor still proves ownership; list the child once so its end is visible.
      if (child.stopped || metadata.killed) {
        proven.push(child.id)
      }
    } else if (child.stopped && pane.pendingLaunches.size === 0) {
      // While a spawn is pending a failed read retries next poll instead of losing its proof.
      retireAntigravityChild(pane, child.id)
    }
  }
  pane.dirty = false
  if (antigravityHelpersSettled(pane) && now >= (antigravityIdleGraceEndsAt(pane) ?? Infinity)) {
    pane.helpersIdleAt = undefined
  }
  const payload = buildAntigravityFoldedStatusPayload(state, original.paneKey, pane, now)
  if (payload?.state === 'done' && pane.rootStop === 'idle' && pane.rootTranscriptPath) {
    state.antigravityCompletedTranscriptByPaneKey.set(original.paneKey, pane.rootTranscriptPath)
  }
  // Publish a child proven after it stopped once, so relayed receivers also see it end.
  for (const id of proven) {
    retireAntigravityChild(pane, id)
  }
  return payload
    ? {
        ...original,
        hookEventName: undefined,
        antigravityHelpersDrained:
          pane.leadState === 'done' && pane.helpersIdleAt !== undefined && proven.length === 0
            ? true
            : undefined,
        payload
      }
    : undefined
}

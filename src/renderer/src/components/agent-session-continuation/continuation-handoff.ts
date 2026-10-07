import { translate } from '@/i18n/i18n'
import type {
  AgentSessionContinuationOrigin,
  AgentSessionContinuationSource
} from '@/lib/agent-session-continuation'
import type { AiVaultContinuationBridge } from '@/lib/ai-vault-continuation-target'
import type {
  AiVaultSessionHandoffFailureReason,
  AiVaultSessionHandoffOutcome
} from '../../../../shared/ai-vault-session-handoff'
import type { ExecutionHostId } from '../../../../shared/execution-host'

function hostChangeFor(args: { sourceHostLabel: string; targetHostLabel: string }): {
  fromLabel: string
  toLabel: string
} {
  return { fromLabel: args.sourceHostLabel, toLabel: args.targetHostLabel }
}

export type ContinuationHandoffPreparation =
  | { kind: 'ready'; source: AgentSessionContinuationSource; degradedToDigest: boolean }
  | { kind: 'failed'; message: string }

function handoffFailureMessage(reason: AiVaultSessionHandoffFailureReason): string {
  if (reason === 'binary-transcript') {
    return translate(
      'components.agentSessionContinuation.handoffBinaryTranscript',
      'This Agent stores its sessions in a database rather than a readable transcript, so it cannot be moved to another host.'
    )
  }
  if (reason === 'source-unavailable') {
    return translate(
      'components.agentSessionContinuation.handoffSourceUnavailable',
      'Could not read the original session transcript from its host.'
    )
  }
  if (reason === 'target-unavailable') {
    return translate(
      'components.agentSessionContinuation.handoffTargetUnavailable',
      'Could not reach the selected host to place the session transcript.'
    )
  }
  return translate(
    'components.agentSessionContinuation.handoffFailed',
    'Could not move the session transcript to the selected host.'
  )
}

function applyOutcome(args: {
  source: AgentSessionContinuationSource
  outcome: AiVaultSessionHandoffOutcome
  hostChange: { fromLabel: string; toLabel: string }
}): ContinuationHandoffPreparation {
  if (args.outcome.kind === 'failed') {
    return { kind: 'failed', message: handoffFailureMessage(args.outcome.reason) }
  }
  if (args.outcome.kind === 'transferred') {
    return {
      kind: 'ready',
      degradedToDigest: false,
      source: {
        ...args.source,
        transcriptPath: args.outcome.transcriptPath,
        hostChange: args.hostChange
      }
    }
  }
  return {
    kind: 'ready',
    degradedToDigest: true,
    source: {
      ...args.source,
      transcriptPath: null,
      capturedText: args.outcome.text,
      capturedTextKind: 'transcript-tail',
      hostChange: args.hostChange
    }
  }
}

/**
 * Give the new session a transcript it can actually read on its own host.
 * Same-host handoffs are untouched; a cross-host one copies the transcript over
 * so both context modes keep working, or degrades to its most recent portion.
 */
export async function prepareContinuationSourceForTarget(args: {
  source: AgentSessionContinuationSource
  origin: AgentSessionContinuationOrigin | undefined
  bridge: AiVaultContinuationBridge
  targetExecutionHostId: ExecutionHostId
  sourceHostLabel: string
  targetHostLabel: string
}): Promise<ContinuationHandoffPreparation> {
  if (args.bridge.kind === 'same-host') {
    return { kind: 'ready', source: args.source, degradedToDigest: false }
  }
  // Why: only a transcript we can still reach is worth re-reading; a preview-only
  // bridge already carries everything that survived.
  const deliver = args.bridge.kind === 'transfer' ? 'file' : 'text'
  const canReadTranscript =
    args.bridge.kind === 'transfer' ||
    (args.bridge.kind === 'inline' && args.bridge.content === 'transcript-tail')
  if (!args.origin?.transcriptPath || !canReadTranscript) {
    // Why: continuing with the vault preview beats refusing to continue at all.
    return {
      kind: 'ready',
      degradedToDigest: true,
      source: { ...args.source, transcriptPath: null, hostChange: hostChangeFor(args) }
    }
  }

  const outcome = await window.api.aiVault.prepareSessionHandoff({
    agent: args.origin.agent,
    sessionId: args.origin.sessionId,
    sourceFilePath: args.origin.transcriptPath,
    sourceExecutionHostId: args.origin.executionHostId ?? null,
    targetExecutionHostId: args.targetExecutionHostId,
    deliver
  })

  return applyOutcome({
    source: args.source,
    outcome,
    hostChange: { fromLabel: args.sourceHostLabel, toLabel: args.targetHostLabel }
  })
}

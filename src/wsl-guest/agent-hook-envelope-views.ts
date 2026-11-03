import type { AgentHookRelayEnvelope } from '../shared/agent-hook-relay'
import { fitInteractivePrompt } from '../shared/agent-status-field-normalization'

/** A replayed held request rides in the projection: it is a second view a receiver can consume. */
export function carriesField(
  envelope: AgentHookRelayEnvelope,
  field: 'lastAssistantMessage' | 'subagents' | 'interactivePrompt'
): boolean {
  return (
    envelope.payload[field] !== undefined ||
    envelope.claudePermission?.row?.payload[field] !== undefined
  )
}

export function copyViews(envelope: AgentHookRelayEnvelope): AgentHookRelayEnvelope {
  const projection = envelope.claudePermission
  return {
    ...envelope,
    payload: { ...envelope.payload },
    ...(projection?.row
      ? {
          claudePermission: {
            ...projection,
            row: { ...projection.row, payload: { ...projection.row.payload } }
          }
        }
      : {})
  }
}

export function waitingCards(envelope: AgentHookRelayEnvelope): ('outer' | 'row')[] {
  const row = envelope.claudePermission?.row?.payload
  return [
    ...(envelope.payload.state === 'waiting' && envelope.payload.interactivePrompt
      ? (['outer'] as const)
      : []),
    ...(row?.state === 'waiting' && row.interactivePrompt ? (['row'] as const) : [])
  ]
}

/** Shortens each consumed waiting view's card, keeping it answerable; other views' cards are shed. */
export function fitWaitingCards(
  envelope: AgentHookRelayEnvelope,
  fits: (candidate: AgentHookRelayEnvelope) => boolean
): AgentHookRelayEnvelope | null {
  let candidate = copyViews(envelope)
  const cards = waitingCards(candidate)
  if (!cards.includes('outer')) {
    delete candidate.payload.interactivePrompt
  }
  if (!cards.includes('row')) {
    delete candidate.claudePermission?.row?.payload.interactivePrompt
  }
  for (const view of cards) {
    const target = view === 'outer' ? candidate.payload : candidate.claudePermission?.row?.payload
    const prompt = target?.interactivePrompt
    if (!target || !prompt) {
      return null
    }
    const fitted = fitInteractivePrompt(prompt, (interactivePrompt) => {
      const probe = copyViews(candidate)
      const probed = view === 'outer' ? probe.payload : probe.claudePermission?.row?.payload
      if (probed) {
        probed.interactivePrompt = interactivePrompt
      }
      return fits(probe)
    })
    if (fitted === null) {
      return null
    }
    candidate = copyViews(candidate)
    const settled = view === 'outer' ? candidate.payload : candidate.claudePermission?.row?.payload
    if (settled) {
      settled.interactivePrompt = fitted
    }
  }
  return candidate
}

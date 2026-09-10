// The pane's live model / thinking-level selection, merged from the two wire
// channels that report it: the `config_update` side channel and the
// `thinking_level_changed` session event. An RPC-owned pane has no TUI left to
// scrape, so these frames are its only source.

import type { OmpRpcClientEvent } from '../../../../shared/omp-rpc-protocol'
import { readOmpRpcThinkingLevelChanged } from '../../../../shared/omp-rpc-session-event-frames'

export type OmpRpcSessionConfig = {
  modelId: string | undefined
  modelName: string | undefined
  provider: string | undefined
  thinkingLevel: string | null
}

/** A bare `config_update` (no model, no level) means "unknown", not "cleared":
 *  `session.model`/`session.thinkingLevel` are both `| undefined` upstream, so
 *  a session that never selected one publishes nothing. Keep the last known
 *  value rather than blanking a model the user really is on. */
export function mergeOmpRpcSessionConfig(
  previous: OmpRpcSessionConfig | null,
  event: Extract<OmpRpcClientEvent, { kind: 'config-update' }>
): OmpRpcSessionConfig {
  const model = event.model
  return {
    modelId: typeof model?.id === 'string' ? model.id : previous?.modelId,
    modelName: typeof model?.name === 'string' ? model.name : previous?.modelName,
    provider: typeof model?.provider === 'string' ? model.provider : previous?.provider,
    thinkingLevel: event.thinkingLevel ?? previous?.thinkingLevel ?? null
  }
}

/** Applies a `thinking_level_changed` session event, if that is what the frame
 *  is. Null means "nothing to project" — either a different session event, or
 *  one that named no level against a config that has never reported one, where
 *  writing an all-undefined config would only fabricate a known-empty state. */
export function applyOmpRpcThinkingLevelEvent(
  previous: OmpRpcSessionConfig | null,
  frame: { type: string } & Record<string, unknown>
): OmpRpcSessionConfig | null {
  const level = readOmpRpcThinkingLevelChanged(frame)
  if (level === null || (level.thinkingLevel === null && previous === null)) {
    return null
  }
  return {
    modelId: previous?.modelId,
    modelName: previous?.modelName,
    provider: previous?.provider,
    thinkingLevel: level.thinkingLevel ?? previous?.thinkingLevel ?? null
  }
}

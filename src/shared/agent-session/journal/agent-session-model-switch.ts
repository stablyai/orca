// A provider telling the chat it switched models mid-conversation: journals as a status row the
// fold never hides, with the from/to pair in a zcode-owned frame so hosts render it distinctly.

export const AGENT_SESSION_MODEL_SWITCH_PRESENTATION = 'model-switch'
export const AGENT_SESSION_MODEL_SWITCH_FRAME_KIND = 'model:switch'

export type AgentSessionModelSwitch = { from: string; to: string }

/** Parse the switch facts out of the row's frame; labels ride in the payload ready for display. */
export function readAgentSessionModelSwitchFrame(
  frame:
    | {
        provider?: string
        kind?: string
        payload?: { head?: string; truncated?: boolean }
      }
    | undefined
): AgentSessionModelSwitch | null {
  if (frame?.provider !== 'zcode' || frame.kind !== AGENT_SESSION_MODEL_SWITCH_FRAME_KIND) {
    return null
  }
  const payload = frame.payload
  if (!payload?.head || payload.truncated) {
    return null
  }
  try {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: zcode app-server frames and provider responses own these payload shapes.
    const parsed = JSON.parse(payload.head) as { type?: unknown; from?: unknown; to?: unknown }
    if (parsed?.type !== 'model-switch') {
      return null
    }
    const from = typeof parsed.from === 'string' && parsed.from ? parsed.from : null
    const to = typeof parsed.to === 'string' && parsed.to ? parsed.to : null
    return from && to ? { from, to } : null
  } catch {
    return null
  }
}

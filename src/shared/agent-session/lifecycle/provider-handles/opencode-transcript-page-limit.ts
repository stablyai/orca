export const OPENCODE_TRANSCRIPT_MAX_WINDOW = 2400

export function openCodeTranscriptPageLimit(limit: number): number {
  return Number.isFinite(limit)
    ? Math.min(OPENCODE_TRANSCRIPT_MAX_WINDOW, Math.max(1, Math.floor(limit)))
    : 300
}

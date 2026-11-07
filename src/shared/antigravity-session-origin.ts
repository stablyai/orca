export const ANTIGRAVITY_HISTORY_ROOTS = [
  'antigravity-cli',
  'antigravity-ide',
  'antigravity'
] as const
/** The ACP server's home under GEMINI_HOME; Orca's managed chat runtime writes here. */
export const ANTIGRAVITY_ACP_HOME = 'antigravity-acp'
export type AntigravitySessionOrigin =
  | (typeof ANTIGRAVITY_HISTORY_ROOTS)[number]
  | typeof ANTIGRAVITY_ACP_HOME

export function antigravitySessionOrigin(filePath: string): AntigravitySessionOrigin | null {
  const segments = filePath.split(/[\\/]+/).filter(Boolean)
  const brainIndex = segments.lastIndexOf('brain')
  // GEMINI_HOME relocates the ACP home, so its parent need not be .gemini.
  if (brainIndex >= 1 && segments[brainIndex - 1] === ANTIGRAVITY_ACP_HOME) {
    return ANTIGRAVITY_ACP_HOME
  }
  if (brainIndex < 2 || segments[brainIndex - 2] !== '.gemini') {
    return null
  }
  return ANTIGRAVITY_HISTORY_ROOTS.find((origin) => origin === segments[brainIndex - 1]) ?? null
}

/** agy cannot resume these natively, so it continues from the transcript; an owning chat reopens instead. */
export function isAntigravityReferenceSession(session: {
  agent: string
  filePath?: string
  structuredSession?: unknown
}): boolean {
  const origin = session.filePath ? antigravitySessionOrigin(session.filePath) : null
  return (
    session.agent === 'antigravity' &&
    origin !== null &&
    origin !== 'antigravity-cli' &&
    !session.structuredSession
  )
}

export function antigravityTranscriptReferencePrompt(filePath: string): string {
  return `Review the chat transcript at ${JSON.stringify(filePath)}. Confirm your understanding of the previous conversation and continue from where it left off. This starts a new CLI conversation using the original transcript as a reference.`
}

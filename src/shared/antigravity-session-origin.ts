export const ANTIGRAVITY_HISTORY_ROOTS = [
  'antigravity-cli',
  'antigravity-ide',
  'antigravity'
] as const
export type AntigravitySessionOrigin = (typeof ANTIGRAVITY_HISTORY_ROOTS)[number]

export function antigravitySessionOrigin(filePath: string): AntigravitySessionOrigin | null {
  const segments = filePath.split(/[\\/]+/).filter(Boolean)
  const brainIndex = segments.lastIndexOf('brain')
  if (brainIndex < 2 || segments[brainIndex - 2] !== '.gemini') {
    return null
  }
  return ANTIGRAVITY_HISTORY_ROOTS.find((origin) => origin === segments[brainIndex - 1]) ?? null
}

export function isAntigravityReferenceSession(session: {
  agent: string
  filePath?: string
}): boolean {
  const origin = session.filePath ? antigravitySessionOrigin(session.filePath) : null
  return session.agent === 'antigravity' && origin !== null && origin !== 'antigravity-cli'
}

export function antigravityTranscriptReferencePrompt(filePath: string): string {
  return `Review the chat transcript at ${JSON.stringify(filePath)}. Confirm your understanding of the previous conversation and continue from where it left off. This starts a new CLI conversation using the original transcript as a reference.`
}

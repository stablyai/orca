import type { UnifiedSessionRow } from './resource-usage-merge-types'

type SessionWithKillVerdict = {
  killVerdict?: UnifiedSessionRow['killVerdict']
  killReason?: string
}

export function killVerdictFields(
  session: SessionWithKillVerdict
): Pick<UnifiedSessionRow, 'killVerdict' | 'killReason'> {
  return session.killVerdict
    ? {
        killVerdict: session.killVerdict,
        ...(session.killReason ? { killReason: session.killReason } : {})
      }
    : {}
}

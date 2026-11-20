import { z } from 'zod'

/** How a removal treats the archive hook; `inherit` runs it when the desktop's Delete would without asking. */
export const ArchiveHookChoiceParam = z.enum(['run', 'skip', 'inherit']).optional()
export type ArchiveHookChoice = NonNullable<z.infer<typeof ArchiveHookChoiceParam>>

export type ArchiveHookDecision =
  | { decision: 'run'; reason: 'requested' | 'approved' }
  | { decision: 'skip'; reason: 'requested' | 'none' | 'not-approved' | 'unverifiable' }

/** `ran` is the host's evidence that the hook executed, not the decision to run it. */
export type ArchiveHookReport = ArchiveHookDecision & { ran: boolean }

export function requestedArchiveHookDecision(
  choice: Exclude<ArchiveHookChoice, 'inherit'>
): ArchiveHookDecision {
  return { decision: choice, reason: 'requested' }
}

export function withArchiveHookReport<T extends { archiveHookRan?: true }>(
  result: T,
  decision: ArchiveHookDecision | undefined
): T & { archiveHook?: ArchiveHookReport } {
  return decision
    ? { ...result, archiveHook: { ...decision, ran: result.archiveHookRan === true } }
    : result
}

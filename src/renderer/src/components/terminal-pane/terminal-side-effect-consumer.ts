import type { TerminalSemanticResident } from './terminal-semantic-residents'
import type { AgentIdleEdgeMeta } from '../../../../shared/terminal-output-side-effects'
import type { ParsedAgentStatusPayload } from '../../../../shared/agent-status-types'
import type { TerminalGitHubPRLink } from '../../../../shared/terminal-github-pr-link-detector'

import type { TerminalResidentBinding, TerminalResidentServices } from './terminal-resident-policy'

export type TerminalSideEffectFactConsumerCallbacks = {
  onAgentStatus?: (payload: ParsedAgentStatusPayload) => void
  /** `meta.staleWorkingTitleClear` marks facts derived from main's 3s
   *  stale-title timer — policy must clear title/cache state without
   *  scheduling task-complete notifications or unread attention. */
  onTitleChange?: (
    normalizedTitle: string,
    rawTitle: string,
    meta?: { staleWorkingTitleClear?: boolean }
  ) => void
  onBell?: () => void
  onAgentBecameIdle?: (title: string, meta?: AgentIdleEdgeMeta) => void
  onAgentBecameWorking?: () => void
  onAgentExited?: () => void
  /** OSC 133;D — same policy hook the byte-mode commandLifecycle drove
   *  (stale agent-status row drop + interrupt-inference coordination). */
  onCommandFinished?: (bestEffortExitCode: number | null) => void
  onCommandStarted?: () => void
  onPrLink?: (link: TerminalGitHubPRLink) => void
  /** Command Code output scrape (no hooks): working seeds the status row;
   *  done is settle-checked by the pane policy before completing the turn. */
  onCommandCodeWorking?: (prompt: string) => void
  onCommandCodeDone?: (prompt: string) => void
  /** DECSET 2031 subscribe observed by main's tracker. Registered only by
   *  hidden-delivery-gated consumers (their bytes never arrive); it records the
   *  subscription for later theme-flip pushes, it does not answer. */
  onMode2031Subscribe?: () => void
  /** DECSET 2031 withdrawal observed by main's tracker. Clears the pane's
   *  subscription registry so later theme flips stop pushing CSI 997. */
  onMode2031Unsubscribe?: () => void
}

export type ConsumerEntry = {
  binding: TerminalResidentBinding
  services?: TerminalResidentServices
  onResident: (resident: TerminalSemanticResident) => () => void
  detachPresentation?: () => void
  resident?: TerminalSemanticResident
}

export type TerminalSideEffectFactConsumerOptions = Pick<
  ConsumerEntry,
  'binding' | 'services' | 'onResident'
> & {
  ptyId: string
  restoreTitleOnRegister?: boolean
}

export function attachResidentConsumer(
  entry: ConsumerEntry,
  resident: TerminalSemanticResident
): void {
  if (entry.resident === resident) {
    return
  }
  entry.detachPresentation?.()
  entry.resident = resident
  entry.detachPresentation = entry.onResident(resident)
}

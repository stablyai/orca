import { TERMINAL_HOST_CAP_HINT } from './terminal-spawn-error-copy'

export const TERMINAL_HOST_CAP_CODE = 'terminal_host_cap'

/** The host refused a new terminal at its cap. Counts are absent from hosts that predate them. */
export type TerminalHostCapRefusal = {
  code: typeof TERMINAL_HOST_CAP_CODE
  inUse?: number
  limit?: number
}

// The worded refusal, as receipts store it for later readers.
const DESCRIBED_CAP = 'because this host is at its terminal limit'
const COUNTS_SUFFIX = /^ \((\d+) of (\d+) terminals in use\)/
const ANY_COUNTS_SUFFIX = / \(\d+ of \d+ terminals in use\)/g

/** Only the message crosses daemon and RPC envelopes, so it carries the counts after the hint. */
export class TerminalHostCapError extends Error {
  readonly code = TERMINAL_HOST_CAP_CODE

  constructor(
    readonly inUse: number,
    readonly limit: number
  ) {
    super(`${TERMINAL_HOST_CAP_HINT} (${inUse} of ${limit} terminals in use)`)
    this.name = 'TerminalHostCapError'
  }
}

/** For string readers that show the hint alone, such as the translated toast. */
export function withoutTerminalHostCapCounts(message: string): string {
  return message.replaceAll(ANY_COUNTS_SUFFIX, '')
}

/** Finds the refusal in any wrapping of its message, such as a startup-terminal warning, or in its worded form. */
export function readTerminalHostCapRefusal(error: unknown): TerminalHostCapRefusal | null {
  if (error instanceof TerminalHostCapError) {
    return { code: TERMINAL_HOST_CAP_CODE, inUse: error.inUse, limit: error.limit }
  }
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const marker = [TERMINAL_HOST_CAP_HINT, DESCRIBED_CAP].find((text) => message.includes(text))
  if (marker === undefined) {
    return null
  }
  const counts = COUNTS_SUFFIX.exec(message.slice(message.indexOf(marker) + marker.length))
  return counts
    ? { code: TERMINAL_HOST_CAP_CODE, inUse: Number(counts[1]), limit: Number(counts[2]) }
    : { code: TERMINAL_HOST_CAP_CODE }
}

// From this share of the cap, agents are told how many terminals are in use.
const USAGE_NOTICE_RATIO = 0.8

/** How close this computer is to its terminal cap, once that is worth an agent telling the user. */
export function terminalUsageNotice(
  usage: { terminalsInUse: number; maxTerminals: number } | null | undefined
): string | undefined {
  if (
    !usage ||
    usage.maxTerminals <= 0 ||
    usage.terminalsInUse < usage.maxTerminals * USAGE_NOTICE_RATIO
  ) {
    return undefined
  }
  return `${usage.terminalsInUse} of ${usage.maxTerminals} in use on this computer; release finished workers with \`orca orchestration worker-release --dispatch <dispatch_id>\` (list them with \`orca orchestration worker-list --terminal-state reclaimable\`)`
}

/** Why a start failed at the cap and how to free terminals, for agents and the people they tell. */
export function describeTerminalHostCapRefusal(
  refusal: TerminalHostCapRefusal,
  subject = 'a new terminal'
): string {
  const counts =
    refusal.inUse !== undefined && refusal.limit !== undefined
      ? ` (${refusal.inUse} of ${refusal.limit} terminals in use)`
      : ''
  return `Orca refused ${subject} ${DESCRIBED_CAP}${counts}. Free terminals, then try again: release finished workers (list them with your Orca CLI's \`orchestration worker-list --terminal-state reclaimable\`, release each with \`orchestration worker-release --dispatch <dispatch_id>\`), or close terminals you no longer need.`
}

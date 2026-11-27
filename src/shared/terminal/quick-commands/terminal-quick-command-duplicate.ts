import type { TerminalQuickCommand } from './terminal-quick-command-types'

/** `formatCopyLabel(1)` is the plain copy label; higher numbers are "copy N" variants. */
export function getDuplicateTerminalQuickCommandLabel(
  siblingLabels: readonly string[],
  formatCopyLabel: (copyNumber: number) => string
): string {
  const taken = new Set(siblingLabels.map((label) => label.trim()))
  // Why: n labels can occupy at most n candidates, so one in the first n + 1 is free.
  for (let copyNumber = 1; copyNumber <= taken.size; copyNumber++) {
    const candidate = formatCopyLabel(copyNumber)
    if (!taken.has(candidate.trim())) {
      return candidate
    }
  }
  return formatCopyLabel(taken.size + 1)
}

/** Spreads the source so fields added to the model later carry over; only identity is replaced. */
export function duplicateTerminalQuickCommand(
  source: TerminalQuickCommand,
  identity: { id: string; label: string }
): TerminalQuickCommand {
  return { ...source, id: identity.id, label: identity.label }
}

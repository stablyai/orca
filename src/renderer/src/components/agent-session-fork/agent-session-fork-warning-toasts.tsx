import type { ReactNode } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { AgentSessionForkSource, AgentSessionForkWarning } from '@/lib/agent-session-fork-flow'
import type { WorkingTreeCarryFailureReason } from '../../../../shared/working-tree-change-carry'

function carryReasonLabel(reason: WorkingTreeCarryFailureReason): string {
  switch (reason) {
    case 'too_large':
      return translate(
        'components.agentSessionFork.carryReason.too_large',
        'Too many new files to copy.'
      )
    case 'base_mismatch':
      return translate(
        'components.agentSessionFork.carryReason.base_mismatch',
        'The new branch does not start at the same commit.'
      )
    case 'target_dirty':
      return translate(
        'components.agentSessionFork.carryReason.target_dirty',
        'The new workspace already had changes.'
      )
    case 'partially_applied':
      return translate(
        'components.agentSessionFork.carryReason.partially_applied',
        'Some uncommitted changes may already be in the new workspace. Review its changes before continuing.'
      )
    case 'apply_failed':
      return translate(
        'components.agentSessionFork.carryReason.apply_failed',
        'The changes could not be applied.'
      )
  }
}

const CARRY_DETAIL_MAX_CHARS = 200

function truncateCarryDetail(detail: string): string {
  const trimmed = detail.trim()
  return trimmed.length > CARRY_DETAIL_MAX_CHARS
    ? `${trimmed.slice(0, CARRY_DETAIL_MAX_CHARS - 1)}…`
    : trimmed
}

function carryFailureDescription(
  reason: WorkingTreeCarryFailureReason,
  detail: string | undefined
): ReactNode {
  const reasonLabel = carryReasonLabel(reason)
  if (!detail?.trim()) {
    return reasonLabel
  }
  // Why: the host's raw message is what lets the user fix it, e.g. a symlinked folder.
  return (
    <>
      <span className="block">{reasonLabel}</span>
      <span className="mt-1 block font-mono text-[11px] break-words">
        {truncateCarryDetail(detail)}
      </span>
    </>
  )
}

export function showAgentSessionForkWarnings(
  warnings: AgentSessionForkWarning[],
  name: string,
  source: AgentSessionForkSource
): void {
  for (const warning of warnings) {
    if (warning.kind === 'changes-not-carried') {
      const title =
        warning.reason === 'partially_applied'
          ? translate(
              'components.agentSessionFork.changesUncertain',
              'Created {{name}}, but it is unclear whether all your uncommitted changes were copied.',
              { name }
            )
          : translate(
              'components.agentSessionFork.changesNotCarried',
              'Created {{name}} without your uncommitted changes.',
              { name }
            )
      toast.warning(title, {
        description: carryFailureDescription(warning.reason, warning.detail)
      })
    } else if (source.kind !== 'transcript') {
      // Why: a failed transcript launch already told the user its context is on the clipboard.
      toast.warning(
        translate(
          'components.agentSessionFork.agentNotStarted',
          'Created {{name}}, but the agent could not start.',
          { name }
        )
      )
    }
  }
}

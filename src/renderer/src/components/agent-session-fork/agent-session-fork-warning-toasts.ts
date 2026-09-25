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
        'The new worktree already had changes.'
      )
    case 'partially_applied':
      return translate(
        'components.agentSessionFork.carryReason.partially_applied',
        'Some uncommitted changes may already be in the new worktree. Review its changes before continuing.'
      )
    case 'apply_failed':
      return translate(
        'components.agentSessionFork.carryReason.apply_failed',
        'The changes could not be applied.'
      )
  }
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
      toast.warning(title, { description: carryReasonLabel(warning.reason) })
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

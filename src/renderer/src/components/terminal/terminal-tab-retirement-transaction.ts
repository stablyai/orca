import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { resolveTerminalWorktreeRoute } from '@/lib/terminal-worktree-route'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { useAppStore } from '@/store'
import {
  buildTerminalTabRetirementPlan,
  type TerminalTabRetirementPlan
} from '@/store/slices/terminal-tab-retirement'

export function reportTerminalCloseError(
  error: Error,
  onError?: (error: Error) => void,
  retry?: () => void
): void {
  if (onError) {
    onError(error)
    return
  }
  toast.error(
    translate(
      'auto.components.terminal.terminal.tab.retirement.transaction.bca566909a',
      'Terminal was not closed'
    ),
    {
      description: error.message,
      action: {
        label: translate(
          'auto.components.terminal.terminal.tab.retirement.transaction.b2c07ffc64',
          'Retry'
        ),
        onClick: retry ?? (() => {})
      }
    }
  )
}

export async function retireArchivedTerminalPtys(
  tabId: string,
  worktreeId: string
): Promise<TerminalTabRetirementPlan> {
  const state = useAppStore.getState()
  const plan = buildTerminalTabRetirementPlan(state, tabId)
  if (plan.unroutablePtyIds.length > 0) {
    throw new Error(
      translate(
        'auto.components.terminal.terminal.tab.retirement.transaction.66acba8f75',
        'Terminal ownership changed and cannot be safely retired. Retry close.'
      )
    )
  }
  const route = resolveTerminalWorktreeRoute(state, worktreeId)
  const teardowns: Promise<unknown>[] = plan.localOrSshPtyIds.map((ptyId) =>
    window.api.pty.kill(ptyId)
  )
  for (const terminal of plan.runtimeTerminals) {
    const environmentId = terminal.environmentId ?? route?.runtimeEnvironmentId
    teardowns.push(
      callRuntimeRpc(
        environmentId ? { kind: 'environment', environmentId } : { kind: 'local' },
        'terminal.close',
        { terminal: terminal.handle }
      )
    )
  }
  const results = await Promise.allSettled(teardowns)
  if (results.some((result) => result.status === 'rejected')) {
    throw new Error(
      translate(
        'auto.components.terminal.terminal.tab.retirement.transaction.1f62db337b',
        'Terminal retirement failed. The archived tab remains open; retry close.'
      )
    )
  }
  return plan
}

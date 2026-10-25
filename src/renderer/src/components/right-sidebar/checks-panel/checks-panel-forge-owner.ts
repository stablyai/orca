import { toRuntimeExecutionHostId } from '../../../../../shared/execution-host'
import { translate } from '@/i18n/i18n'
import { selectExecutionHostDisplayLabel } from '@/lib/execution-host-display-label'
import { forgeCredentialTarget } from '@/runtime/forge-credential-target'
import { useAppStore } from '@/store'

/** A failed checks/comments read, naming the machine that answered so a sign-in error is actionable. */
export function checksPanelLoadErrorMessage(error: unknown, ownerHostId: string): string {
  const detail = error instanceof Error ? error.message : String(error)
  let machine: string
  try {
    const target = forgeCredentialTarget({ repoOwnerExecutionHostId: ownerHostId })
    machine =
      target.kind === 'environment'
        ? selectExecutionHostDisplayLabel(
            useAppStore.getState(),
            toRuntimeExecutionHostId(target.environmentId)
          )
        : translate('auto.runtime.forgeCredentialTarget.thisComputer', 'this computer')
  } catch {
    return detail
  }
  return translate(
    'auto.components.right.sidebar.checks.panel.loadFailedOnMachine',
    'Could not load from {{machine}}: {{detail}}',
    { machine, detail }
  )
}

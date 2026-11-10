// The setup panel's Agent row (cloud-start G) from the Orca account's agent credentials and sources:
// "from your Orca account" / "team key" when covered, "Set up once" (S0) otherwise. Never blocks Start.
import type { Translate } from '@/i18n/use-translate'
import type { OrcaCloudAgentSetupRowModel } from '@/lib/orca-cloud/orca-cloud-agent-setup-row'
import { orcaCloudAgentCoveredLabel, orcaCloudAgentRowCopy } from '../OrcaCloudAgentSetupRow'
import type { CloudSetupStep } from './cloud-start-model'

/** Null hides the row (an agent without an account path, or nothing here helps yet). */
export function cloudStartAgentStep(
  step: CloudSetupStep,
  row: OrcaCloudAgentSetupRowModel,
  t: Translate
): CloudSetupStep | null {
  switch (row.kind) {
    case 'hidden':
      return null
    case 'loading':
      return { ...step, state: 'loading' }
    case 'covered':
      // Covered: the row is done, so the panel collapses once the required rows are too.
      return { ...step, state: 'done', detail: orcaCloudAgentCoveredLabel(row, t) }
    case 'notSetUp':
    case 'expired':
    case 'killSwitch':
    case 'signedOut':
    case 'error': {
      const copy = orcaCloudAgentRowCopy(row, t)
      return {
        ...step,
        state: 'optional',
        detail: copy.detail,
        ...(copy.status ? { status: copy.status } : {}),
        ...(copy.action ? { action: copy.action } : {})
      }
    }
  }
}

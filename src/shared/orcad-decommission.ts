/** What a client learns from decommissioning a managed orcad. */
import type { OrcadManagedRefusal } from './orcad-managed-runtime'
import type { OrcadDaemonRetirementVerdict } from './orcad-stop-request'

export type OrcadDecommissionResult =
  | {
      outcome: 'decommissioned'
      version: string
      /** The daemon's fate: `retired`, or kept with its terminals (`live`/`unverifiable`). */
      retirement: OrcadDaemonRetirementVerdict
    }
  | OrcadManagedRefusal

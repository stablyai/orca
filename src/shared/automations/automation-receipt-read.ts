import type { Automation } from './automation-definition'
import type { AutomationOwnerPrecondition } from './ownership/automation-owner-precondition'

/** A fresh intentional read; none of this authority is stored in the transcript. */
export type AutomationReceiptRead =
  | { status: 'unverified' }
  | { status: 'missing' }
  | { status: 'mismatch' }
  | {
      status: 'ready'
      automation: Automation
      owner: AutomationOwnerPrecondition
      effectiveZone?: string
    }

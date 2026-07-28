import type {
  TerminalTabCloseReason,
  TerminalTabRetirementPlan
} from '@/store/slices/terminal-tab-retirement'
import type { PrecomputedTerminalCloseState } from './terminal-close-target'

export type TerminalTabCloseOptions = {
  force?: boolean
  rejectPinned?: boolean
  reason?: TerminalTabCloseReason
  /** Wire-only reason that preserves local close guards. */
  hostCloseReason?: TerminalTabCloseReason
  lifecyclePtyId?: string
  captureRecentlyClosed?: boolean
  localPtyTeardownOwnedExternally?: boolean
  precomputedRetirementPlan?: TerminalTabRetirementPlan
  precomputedCloseState?: PrecomputedTerminalCloseState
  providerTeardownTimeoutMs?: number
  providerTeardownDeadlineMs?: number
  onClosed?: (providerTeardown?: Promise<void>) => void
  onCancel?: () => void
}

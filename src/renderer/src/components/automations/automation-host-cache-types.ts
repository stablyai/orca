/** Rows retain captured owners, null when unqualified; requests retain all three generations required by their commit fence. */

import type { Automation } from '../../../../shared/automations-types'
import type { AutomationListItemSelector } from '../../../../shared/automation-list-scope'
import type { LegacyAutomationSelector } from '../../../../shared/automation-legacy-list-partition'
import type {
  AutomationAuthorityRef,
  AutomationOwnerRef
} from '../../../../shared/automation-owner-ref'
import type { AutomationUsageSummary } from '../../../../shared/automation-usage-summary'

/** A legacy SSH row carries no registration generation, which is why it can never be fenced. */
export type AutomationHostRowSelector = AutomationListItemSelector | LegacyAutomationSelector

export type AutomationHostRow = {
  automation: Automation
  /** Null when nothing may be mutated through it: legacy unscoped rows and orphans. */
  owner: AutomationOwnerRef | null
  authority?: AutomationAuthorityRef
  selector: AutomationHostRowSelector
  usageSummary: AutomationUsageSummary | null
  /** False on the legacy path, where the authority sends no projection and none may be fetched. */
  usageKnown: boolean
}

export type AutomationHostQueryErrorCode =
  | 'authority_unavailable'
  | 'timeout'
  | 'permission_denied'
  | 'incompatible'
  | 'invalid_response'
  | 'owner_changed'
  | 'target_removed'
  | 'unknown'

export type AutomationHostQueryError = {
  code: AutomationHostQueryErrorCode
  message: string
  retryable: boolean
  /** Wall-clock time the next automatic attempt may start; null when nothing is scheduled. */
  retryAt: number | null
}

export type AutomationHostCacheEntry = {
  data: readonly AutomationHostRow[]
  fetchedAt: number | null
  attempt: number
  requestGeneration: number
  catalogGeneration: number
  request: Promise<void> | null
  error: AutomationHostQueryError | null
  /** Authoritative orphan count from the last scoped response; null when never reported. */
  orphanCount: number | null
}

/** Require all captured generations to match; catalog generation also covers removed-target tombstones. */
export type AutomationHostRequestFence = {
  stableKey: string
  authorityKey: string
  requestGeneration: number
  catalogGeneration: number
  /** The authority's `pairingRevision`; a fixed constant for desktop. */
  connectionGeneration: number
}

/** Desktop storage is local, so it has no pairing to revise. */
export const DESKTOP_AUTHORITY_CONNECTION_GENERATION = 0

export const AUTOMATION_HOST_CACHE_TTL_MS = 30_000
export const AUTOMATION_HOST_RETIRED_CACHE_LIMIT = 256

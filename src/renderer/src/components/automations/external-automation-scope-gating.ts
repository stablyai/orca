/** External managers are desktop-authority-only here; runtime hosts are unprobed/scope-limited, never proven empty. */

import {
  EXTERNAL_AUTOMATION_SCOPE_CODES,
  type ExternalAutomationScopeCode
} from '../../../../shared/external-automation-scope'
import type { AutomationOwnerRef } from '../../../../shared/automation-owner-ref'
import type { AutomationHostCatalogEntry } from './automation-host-catalog-types'
import type { AutomationHostFilterResolution } from './automation-host-filter-resolution'

export type ExternalAutomationScopeStatus = 'listed' | 'not-listed' | 'unknown'

export type ExternalAutomationScopeGate = {
  status: ExternalAutomationScopeStatus
  /** Non-null only when `listed`; every other status must not probe. */
  probeOwner: AutomationOwnerRef | null
  /** Engine code when one explains the limit; null when no owner was captured. */
  code: ExternalAutomationScopeCode | null
}

const UNKNOWN_GATE: ExternalAutomationScopeGate = {
  status: 'unknown',
  probeOwner: null,
  code: null
}

function notListed(code: ExternalAutomationScopeCode | null): ExternalAutomationScopeGate {
  return { status: 'not-listed', probeOwner: null, code }
}

/** An unresolved/All-hosts selection makes no claim; compose one gate per concrete host instead. */
export function resolveExternalAutomationScopeGate(
  entry: AutomationHostCatalogEntry | null
): ExternalAutomationScopeGate {
  if (!entry) {
    return UNKNOWN_GATE
  }
  if (entry.stableRef.authority.kind !== 'desktop') {
    return notListed(EXTERNAL_AUTOMATION_SCOPE_CODES.authorityNotSupported)
  }
  if (entry.kind === 'orphan') {
    return notListed(null)
  }
  // Fail closed: an uncaptured owner cannot be probed, so nothing is listed for it.
  return entry.owner ? { status: 'listed', probeOwner: entry.owner, code: null } : notListed(null)
}

/** Probe and retain only in-view hosts; filtering away a host removes authorization to query it. */
export function externalAutomationScopeEntries(
  entries: readonly AutomationHostCatalogEntry[],
  resolution: AutomationHostFilterResolution
): readonly AutomationHostCatalogEntry[] {
  if (resolution.effective.kind === 'all') {
    return entries
  }
  return resolution.entry ? [resolution.entry] : []
}

/** Owners the probe pool may keep working on; everything else is cancelled. */
export function externalAutomationProbeOwners(
  entries: readonly AutomationHostCatalogEntry[]
): AutomationOwnerRef[] {
  const owners: AutomationOwnerRef[] = []
  for (const entry of entries) {
    const gate = resolveExternalAutomationScopeGate(entry)
    if (gate.probeOwner) {
      owners.push(gate.probeOwner)
    }
  }
  return owners
}

/** Read the engine’s trailing scope code from IPC’s preserved error message. */
export function externalAutomationScopeGateFromError(
  error: unknown
): ExternalAutomationScopeGate | null {
  const code = parseExternalAutomationScopeCode(error)
  return code ? notListed(code) : null
}

export function parseExternalAutomationScopeCode(
  error: unknown
): ExternalAutomationScopeCode | null {
  const message = (error instanceof Error ? error.message : String(error ?? '')).trimEnd()
  for (const code of Object.values(EXTERNAL_AUTOMATION_SCOPE_CODES)) {
    if (message.endsWith(`: ${code}`)) {
      return code
    }
  }
  return null
}

/**
 * Canonical ownership identity for automation records.
 *
 * An automation ID is unique only inside the authority that stores it, so every
 * row, request, and action carries the authority (desktop or a paired runtime)
 * plus the host selector (self or one SSH target) that produced it.
 *
 * Two forms exist on purpose:
 * - Stable refs survive renames and connection changes; they key the persisted
 *   host filter and the display slot.
 * - Owner refs additionally pin the *incarnation* (`pairingRevision` for a
 *   runtime, `targetGeneration` for an SSH registration) so data captured from
 *   an old incarnation can never commit against a new one.
 */

export type AutomationAuthorityRef =
  | { kind: 'desktop' }
  | {
      kind: 'runtime'
      environmentId: string
      /** The saved runtime environment's pairing revision; a re-pair invalidates captured data. */
      pairingRevision: number
    }

export type AutomationHostSelector =
  | { kind: 'self' }
  | {
      kind: 'ssh'
      targetId: string
      /** Durable SSH *registration* incarnation — not a connection attempt counter. */
      targetGeneration: number
    }

export type AutomationOwnerRef = {
  authority: AutomationAuthorityRef
  selector: AutomationHostSelector
}

export type StableAutomationAuthorityRef =
  | { kind: 'desktop' }
  | { kind: 'runtime'; environmentId: string }

export type StableAutomationHostSelector = { kind: 'self' } | { kind: 'ssh'; targetId: string }

export type StableAutomationHostRef = {
  authority: StableAutomationAuthorityRef
  selector: StableAutomationHostSelector
}

/** A stable host, or the per-authority bucket for records with no executable owner. */
export type StableAutomationCatalogRef =
  | StableAutomationHostRef
  | {
      authority: StableAutomationAuthorityRef
      selector: { kind: 'orphan' }
    }

export type StableAutomationCatalogSelector = StableAutomationCatalogRef['selector']

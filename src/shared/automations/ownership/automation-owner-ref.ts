/** Automation IDs are authority-local: qualify records/actions with authority plus Self/SSH selector. Stable refs key persisted filters/display; owner refs also pin pairingRevision/targetGeneration so stale captures cannot commit to new incarnations. */

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

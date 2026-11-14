import type { AiVaultSessionPublicationGate } from './ai-vault-session-publication-gate'
import type { AiVaultRowsEvent } from '../../../../shared/ai-vault-scan-rows'
import type { AiVaultListResult, AiVaultSession } from '../../../../shared/ai-vault-types'
import { sessionAliasKey } from '../../../../shared/ai-vault-session-alias'
import { reuseEqualCatalogRows } from '@/store/slices/worktree-catalog-reconciliation'

/** Consumes every delta before the lossy input-quiet publication gate. */
export class AiVaultProvisionalRows {
  private scanId: string | null = null
  private sequence = 0
  private readonly rows = new Map<string, AiVaultSession>()
  private retired = false

  constructor(
    private readonly baseline: readonly AiVaultSession[],
    private readonly deleted: ReadonlySet<string> = new Set()
  ) {}

  accept(event: AiVaultRowsEvent): boolean {
    if (this.retired) {
      return false
    }
    if (event.reset) {
      if (event.sequence <= this.sequence) {
        return false
      }
      this.scanId = event.scanId
      this.rows.clear()
    } else if (this.scanId !== event.scanId || event.sequence <= this.sequence) {
      return false
    } else if (event.sequence !== this.sequence + 1) {
      this.retired = true
      return false
    }
    this.sequence = event.sequence
    for (const id of event.removed) {
      this.rows.delete(id)
    }
    for (const row of event.upserts) {
      this.rows.set(row.id, row)
    }
    return true
  }

  snapshot(previous: readonly AiVaultSession[]): readonly AiVaultSession[] {
    const verifiedAliases = new Set([...this.rows.values()].map(sessionAliasKey).filter(Boolean))
    const merged = new Map(
      this.baseline
        .filter((row) => {
          if (this.deleted.has(row.id)) {
            return false
          }
          const key = sessionAliasKey(row)
          return !key || !verifiedAliases.has(key)
        })
        .map((row) => [row.id, row])
    )
    for (const row of this.rows.values()) {
      if (!this.deleted.has(row.id)) {
        merged.set(row.id, row)
      }
    }
    const rows = [...merged.values()].sort(
      (a, b) => Date.parse(b.updatedAt ?? b.modifiedAt) - Date.parse(a.updatedAt ?? a.modifiedAt)
    )
    return reuseEqualCatalogRows(previous, rows)
  }

  retire(): void {
    this.retired = true
  }
}

export function retainAiVaultFailedHostRows(
  result: AiVaultListResult,
  previous: readonly AiVaultSession[]
): readonly AiVaultSession[] | null {
  const failed = new Set(
    result.issues.filter((issue) => issue.kind === 'host').map((issue) => issue.executionHostId)
  )
  if (failed.size === 0) {
    return null
  }
  const rows = new Map(
    previous.filter((row) => failed.has(row.executionHostId)).map((row) => [row.id, row])
  )
  for (const row of result.sessions) {
    rows.set(row.id, row)
  }
  return [...rows.values()]
}

export function observeAiVaultProvisionalRows(args: {
  requestToken: string
  baseline: readonly AiVaultSession[]
  deleted: ReadonlySet<string>
  gate: AiVaultSessionPublicationGate
  isCurrent: () => boolean
  apply: (rows: readonly AiVaultSession[]) => void
}): () => void {
  const preview = new AiVaultProvisionalRows(args.baseline, args.deleted)
  let observing = true
  let rows: readonly AiVaultSession[] = args.baseline
  const unsubscribe = window.api.aiVault.onScanRows?.((event) => {
    if (!observing || event.requestToken !== args.requestToken || !args.isCurrent()) {
      return
    }
    if (!preview.accept(event)) {
      return
    }
    args.gate.publishProvisional(() => {
      if (!observing || !args.isCurrent()) {
        return
      }
      rows = preview.snapshot(rows)
      args.apply(rows)
    })
  })
  return () => {
    observing = false
    preview.retire()
    unsubscribe?.()
  }
}

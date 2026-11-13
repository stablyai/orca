import * as z from 'zod'

/** The id every reader keys a catalog row by; consumers validate their own projections of the rest. */
export function isWorktreeCatalogRow(row: unknown): row is { worktreeId: string } {
  return (
    typeof row === 'object' &&
    row !== null &&
    'worktreeId' in row &&
    typeof row.worktreeId === 'string'
  )
}

export type WorktreeCatalogAdmission<Row> =
  | { kind: 'full'; snapshotId: string | null; worktrees: Row[] }
  | { kind: 'unchanged'; snapshotId: string }
  // Entries are rows, or indexes into the catalog the caller holds under baseSnapshotId.
  | { kind: 'delta'; snapshotId: string; baseSnapshotId: string; rowsFromBase: (number | Row)[] }
  | { kind: 'invalid' }

export type WorktreeCatalogSnapshot<Row> = { snapshotId: string | null; worktrees: Row[] }

export type WorktreeCatalogSnapshotParams = {
  afterSnapshotId?: string | null
  acceptRowDelta: true
}

/** Sends one worktree.ps read with the snapshot fields; the refusal code is the host's, or request_failed. */
export type WorktreeCatalogSnapshotRequest = (
  snapshot: WorktreeCatalogSnapshotParams
) => Promise<{ accepted: true; value: unknown } | { accepted: false; code: string }>

const snapshotIdSchema = z.string().min(1).max(128)

/** Admits and rebuilds worktree.ps row-delta replies for one row type. */
export function worktreeCatalogRowDelta<Row>(isRow: (row: unknown) => row is Row) {
  const rowSchema = z.custom<Row>(isRow)
  // One unreadable row fails the whole reply: dropping it would shift later deltas' base indexes.
  const replySchema = z.looseObject({
    worktrees: z.array(rowSchema).optional().catch(undefined),
    snapshotId: snapshotIdSchema.optional().catch(undefined),
    unchanged: z.boolean().optional().catch(undefined),
    baseSnapshotId: snapshotIdSchema.optional().catch(undefined),
    rowsFromBase: z
      .array(z.union([z.number(), rowSchema]))
      .optional()
      .catch(undefined)
  })

  function admit(
    result: unknown,
    requestedSnapshotId: string | null
  ): WorktreeCatalogAdmission<Row> {
    const parsed = replySchema.safeParse(result)
    if (!parsed.success) {
      return { kind: 'invalid' }
    }
    const { worktrees, unchanged, baseSnapshotId, rowsFromBase } = parsed.data
    const snapshotId = parsed.data.snapshotId ?? null
    // Rows identify a full response; a future unchanged field must not reclassify one.
    if (worktrees) {
      return { kind: 'full', snapshotId, worktrees }
    }
    if (unchanged === true && snapshotId && snapshotId === requestedSnapshotId) {
      return { kind: 'unchanged', snapshotId }
    }
    if (
      snapshotId &&
      requestedSnapshotId !== null &&
      baseSnapshotId === requestedSnapshotId &&
      rowsFromBase
    ) {
      return { kind: 'delta', snapshotId, baseSnapshotId, rowsFromBase }
    }
    return { kind: 'invalid' }
  }

  /**
   * Reads the catalog on top of the one the caller holds: an unchanged reply returns `held` itself,
   * a delta rebuilds from its rows, and a delta that can't be rebuilt asks once in full.
   */
  async function read(
    request: WorktreeCatalogSnapshotRequest,
    held: WorktreeCatalogSnapshot<Row> | null | undefined
  ): Promise<{ ok: true; snapshot: WorktreeCatalogSnapshot<Row> } | { ok: false; code: string }> {
    let base = held?.snapshotId ? held : null
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const requestedSnapshotId = base?.snapshotId ?? null
      const catalog = await request({ afterSnapshotId: requestedSnapshotId, acceptRowDelta: true })
      if (!catalog.accepted) {
        return { ok: false, code: catalog.code }
      }
      const admission = admit(catalog.value, requestedSnapshotId)
      const next = applyWorktreeCatalogAdmission(base, admission)
      if (next) {
        return { ok: true, snapshot: next }
      }
      if (admission.kind !== 'delta') {
        break
      }
      base = null
    }
    return { ok: false, code: 'invalid_response' }
  }

  return { admit, read }
}

/** The catalog an admitted reply describes on top of `held`; null when it can't be rebuilt from it. */
export function applyWorktreeCatalogAdmission<Row>(
  held: WorktreeCatalogSnapshot<Row> | null,
  admission: WorktreeCatalogAdmission<Row>
): WorktreeCatalogSnapshot<Row> | null {
  if (admission.kind === 'full') {
    return { snapshotId: admission.snapshotId, worktrees: admission.worktrees }
  }
  if (admission.kind === 'invalid' || !held || held.snapshotId === null) {
    return null
  }
  if (admission.kind === 'unchanged') {
    return admission.snapshotId === held.snapshotId ? held : null
  }
  if (admission.baseSnapshotId !== held.snapshotId) {
    return null
  }
  const worktrees = rebuildFromBase(admission.rowsFromBase, held.worktrees)
  return worktrees && { snapshotId: admission.snapshotId, worktrees }
}

// Null when an index falls outside the base; the caller then asks for a full catalog.
function rebuildFromBase<Row>(rowsFromBase: (number | Row)[], base: Row[]): Row[] | null {
  const rows: Row[] = []
  for (const entry of rowsFromBase) {
    if (typeof entry !== 'number') {
      rows.push(entry)
      continue
    }
    const row = Number.isInteger(entry) ? base[entry] : undefined
    if (row === undefined) {
      return null
    }
    rows.push(row)
  }
  return rows
}

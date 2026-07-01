// Pure staged-edit buffer for the table Data grid. Cell edits, new rows, and
// row deletes accumulate here (keyed by primary-key values) and are turned into
// parameterized statements only on Save — applied atomically via executeBatch.
// Kept pure so staging + statement generation are unit-testable without React.

import type { DbEngine, DbStatement } from '../../../../shared/database-types'
import {
  buildDeleteByKeySql,
  buildInsertSql,
  buildUpdateByKeySql
} from '../../../../shared/table-data-sql'

// A not-yet-inserted row. `tempId` is a client-only handle; `values` holds only
// the columns the user filled (the rest fall back to DB defaults on INSERT).
export type DbNewRow = { tempId: string; values: Record<string, unknown> }

export type DbEditBuffer = {
  // rowKey → { columnName: newValue } for edited existing rows.
  updates: Record<string, Record<string, unknown>>
  // rowKeys of existing rows marked for deletion.
  deletes: string[]
  inserts: DbNewRow[]
}

export function emptyEditBuffer(): DbEditBuffer {
  return { updates: {}, deletes: [], inserts: [] }
}

export function isBufferDirty(buffer: DbEditBuffer): boolean {
  return (
    Object.keys(buffer.updates).length > 0 ||
    buffer.deletes.length > 0 ||
    buffer.inserts.length > 0
  )
}

// Number of pending row-level changes (edited + deleted + inserted rows).
export function bufferChangeCount(buffer: DbEditBuffer): number {
  return Object.keys(buffer.updates).length + buffer.deletes.length + buffer.inserts.length
}

// Stable per-row key from its primary-key values (positional to keyColumns).
export function rowKeyFor(keyColumns: string[], columnNames: string[], row: unknown[]): string {
  return JSON.stringify(keyColumns.map((k) => row[columnNames.indexOf(k)]))
}

// Cells are equal if identical, or if both non-null and share a string form (so
// re-typing a number's text — e.g. "18" over 18 — doesn't stage a no-op update).
// NULL stays distinct from '' so clearing a value to empty is a real change.
function sameCellValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) {
    return true
  }
  if (a == null || b == null) {
    return false
  }
  return String(a) === String(b)
}

// Stage (or, if the value equals the original, un-stage) one cell edit.
export function stageCellEdit(
  buffer: DbEditBuffer,
  rowKey: string,
  column: string,
  value: unknown,
  original: unknown
): DbEditBuffer {
  const rowEdits = { ...(buffer.updates[rowKey] ?? {}) }
  if (sameCellValue(value, original)) {
    delete rowEdits[column]
  } else {
    rowEdits[column] = value
  }
  const updates = { ...buffer.updates }
  if (Object.keys(rowEdits).length === 0) {
    delete updates[rowKey]
  } else {
    updates[rowKey] = rowEdits
  }
  return { ...buffer, updates }
}

// Toggle an existing row's delete mark.
export function toggleDeleteRow(buffer: DbEditBuffer, rowKey: string): DbEditBuffer {
  const marked = buffer.deletes.includes(rowKey)
  return {
    ...buffer,
    deletes: marked ? buffer.deletes.filter((k) => k !== rowKey) : [...buffer.deletes, rowKey]
  }
}

export function addNewRow(buffer: DbEditBuffer, tempId: string): DbEditBuffer {
  return { ...buffer, inserts: [...buffer.inserts, { tempId, values: {} }] }
}

export function editNewRowCell(
  buffer: DbEditBuffer,
  tempId: string,
  column: string,
  value: unknown
): DbEditBuffer {
  return {
    ...buffer,
    inserts: buffer.inserts.map((r) =>
      r.tempId === tempId ? { ...r, values: { ...r.values, [column]: value } } : r
    )
  }
}

export function discardNewRow(buffer: DbEditBuffer, tempId: string): DbEditBuffer {
  return { ...buffer, inserts: buffer.inserts.filter((r) => r.tempId !== tempId) }
}

// The overlay value shown for an existing cell: the staged edit if present,
// else the original. `hasEdit` drives the dirty highlight.
export function overlayCell(
  buffer: DbEditBuffer,
  rowKey: string,
  column: string,
  original: unknown
): { value: unknown; hasEdit: boolean } {
  const edited = buffer.updates[rowKey]
  if (edited && column in edited) {
    return { value: edited[column], hasEdit: true }
  }
  return { value: original, hasEdit: false }
}

// Turn the buffer into ordered parameterized statements. Deletes first (free up
// unique keys), then updates, then inserts. WHERE keys read the ORIGINAL row from
// `rowsByKey` so editing a PK column still targets the right row.
export function bufferToStatements(
  engine: DbEngine,
  ctx: {
    schema: string
    table: string
    keyColumns: string[]
    columnNames: string[]
    rowsByKey: Record<string, unknown[]>
  },
  buffer: DbEditBuffer
): DbStatement[] {
  const keyValuesFor = (rowKey: string): unknown[] => {
    const row = ctx.rowsByKey[rowKey]
    // Fail closed: a missing row or unresolved PK column would otherwise bind
    // `undefined` and produce an invalid / no-op UPDATE/DELETE. The caller
    // surfaces this as a save error instead of silently issuing a wrong write.
    if (!row) {
      throw new Error('db_edit_row_unresolved')
    }
    return ctx.keyColumns.map((k) => {
      const index = ctx.columnNames.indexOf(k)
      if (index === -1) {
        throw new Error('db_edit_key_column_missing')
      }
      return row[index]
    })
  }
  const statements: DbStatement[] = []

  for (const rowKey of buffer.deletes) {
    statements.push(
      buildDeleteByKeySql(engine, {
        schema: ctx.schema,
        table: ctx.table,
        keyColumns: ctx.keyColumns,
        keyValues: keyValuesFor(rowKey)
      })
    )
  }
  for (const [rowKey, set] of Object.entries(buffer.updates)) {
    // A delete on the same row wins — skip a doomed update.
    if (buffer.deletes.includes(rowKey)) {
      continue
    }
    statements.push(
      buildUpdateByKeySql(engine, {
        schema: ctx.schema,
        table: ctx.table,
        set,
        keyColumns: ctx.keyColumns,
        keyValues: keyValuesFor(rowKey)
      })
    )
  }
  for (const row of buffer.inserts) {
    statements.push(buildInsertSql(engine, { schema: ctx.schema, table: ctx.table, values: row.values }))
  }
  return statements
}

import { useCallback, useEffect, useRef, useState } from 'react'
import type { SqliteCell } from '../../../../shared/sqlite-database'

// Wider than a viewport so ordinary scrolling hits cache, under the main process's 500-row cap.
export const SQLITE_ROW_CHUNK = 200

// Tripwire: bounds renderer memory on a table with millions of rows.
const MAX_RESIDENT_CHUNKS = 60

export type SqliteRowWindow = {
  getRow: (index: number) => SqliteCell[] | undefined
  ensureRange: (startIndex: number, endIndex: number) => void
  columns: string[]
  error: string | null
}

type ChunkState = Map<number, SqliteCell[][]>

export function useSqliteTableRows(
  filePath: string,
  table: string | null,
  rowCount: number
): SqliteRowWindow {
  const [chunks, setChunks] = useState<ChunkState>(() => new Map())
  const [columns, setColumns] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const pending = useRef(new Set<number>())
  // Mirrors `chunks` so loadChunk needs no state dependency; set inside the updater so an evicted chunk is never marked resident.
  const resident = useRef<ChunkState>(new Map())
  const lastRequested = useRef(0)
  // Drops a response for a table the user already switched away from.
  const generation = useRef(0)

  useEffect(() => {
    generation.current += 1
    pending.current = new Set()
    resident.current = new Map()
    setChunks(new Map())
    setColumns([])
    setError(null)
  }, [filePath, table])

  const loadChunk = useCallback(
    async (chunkIndex: number): Promise<void> => {
      if (table === null || pending.current.has(chunkIndex) || resident.current.has(chunkIndex)) {
        return
      }
      pending.current.add(chunkIndex)
      const requestGeneration = generation.current
      try {
        const page = await window.api.sqlite.readTablePage({
          filePath,
          table,
          offset: chunkIndex * SQLITE_ROW_CHUNK,
          limit: SQLITE_ROW_CHUNK
        })
        if (requestGeneration !== generation.current) {
          return
        }
        setColumns((current) => (current.length > 0 ? current : page.columns))
        setChunks((current) => {
          const next = new Map(current)
          next.set(chunkIndex, page.rows)
          if (next.size > MAX_RESIDENT_CHUNKS) {
            const furthest = [...next.keys()].sort(
              (a, b) => Math.abs(b - lastRequested.current) - Math.abs(a - lastRequested.current)
            )
            for (const key of furthest.slice(0, next.size - MAX_RESIDENT_CHUNKS)) {
              next.delete(key)
            }
          }
          resident.current = next
          return next
        })
        setError(null)
      } catch (err) {
        if (requestGeneration === generation.current) {
          setError(err instanceof Error ? err.message : String(err))
        }
      } finally {
        pending.current.delete(chunkIndex)
      }
    },
    [filePath, table]
  )

  const ensureRange = useCallback(
    (startIndex: number, endIndex: number): void => {
      if (table === null || rowCount === 0) {
        return
      }
      const firstChunk = Math.max(0, Math.floor(startIndex / SQLITE_ROW_CHUNK))
      const lastChunk = Math.floor(Math.min(endIndex, rowCount - 1) / SQLITE_ROW_CHUNK)
      lastRequested.current = firstChunk
      for (let chunk = firstChunk; chunk <= lastChunk; chunk += 1) {
        void loadChunk(chunk)
      }
    },
    [loadChunk, rowCount, table]
  )

  const getRow = useCallback(
    (index: number): SqliteCell[] | undefined =>
      chunks.get(Math.floor(index / SQLITE_ROW_CHUNK))?.[index % SQLITE_ROW_CHUNK],
    [chunks]
  )

  return { getRow, ensureRange, columns, error }
}

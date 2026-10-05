import { useCallback, useEffect, useRef, useState } from 'react'
import type { CsvFilePreview } from './editor-csv-file-content'
import { CsvPagedPreview } from './csv-paged-preview'
import type { CsvIndex } from './csv-byte-index'

type PreviewState = {
  index: CsvIndex | null
  header: string[]
  sample: string[][]
  rows: Map<number, string[]>
  progress: number
  error: string | null
}
const initialState = (): PreviewState => ({
  index: null,
  header: [],
  sample: [],
  rows: new Map(),
  progress: 0,
  error: null
})

export function useCsvPagedPreview(file: CsvFilePreview, delimiter: string) {
  const [state, setState] = useState(initialState)
  const requestRows = useRef<(first: number, last: number) => void>(() => {})
  useEffect(() => {
    const preview = new CsvPagedPreview(file)
    let canceled = false
    let wanted: { first: number; last: number } | null = null
    let loading = false
    const fail = (error: unknown): void => {
      if (canceled) {
        return
      }
      preview.close()
      requestRows.current = () => {}
      setState((previous) => ({
        ...previous,
        error: error instanceof Error ? error.message : String(error)
      }))
    }
    setState(initialState())
    void (async () => {
      const index = await preview.buildIndex(delimiter, (progress) => {
        if (!canceled) {
          setState((previous) => ({ ...previous, progress }))
        }
      })
      const firstPage = index.pages[0] ? await preview.page(0, index.pages[0]) : []
      if (canceled) {
        return
      }
      setState({
        index,
        header: firstPage[0] ?? [],
        sample: firstPage.slice(1, 201),
        rows: new Map(firstPage.slice(1).map((row, i) => [i, row])),
        progress: file.snapshot.size,
        error: null
      })
      const loadLatest = async (): Promise<void> => {
        if (loading) {
          return
        }
        loading = true
        try {
          while (wanted && !canceled) {
            const range = wanted
            wanted = null
            const rows = await preview.rows(
              index,
              range.first,
              range.last,
              () => canceled || wanted !== null
            )
            if (rows && !canceled && !wanted) {
              setState((previous) => ({ ...previous, rows }))
            }
          }
        } finally {
          loading = false
        }
      }
      requestRows.current = (first, last) => {
        wanted = { first, last }
        void loadLatest().catch(fail)
      }
    })().catch(fail)
    return () => {
      canceled = true
      requestRows.current = () => {}
      preview.close()
    }
  }, [file, delimiter])
  const onVisibleRows = useCallback(
    (first: number, last: number) => requestRows.current(first, last),
    []
  )
  const getRow = useCallback((index: number) => state.rows.get(index), [state.rows])
  return { ...state, onVisibleRows, getRow }
}

import { useCallback, useEffect, useRef, useState } from 'react'
import type { RuntimeFileReadArgs } from '@/runtime/files/runtime-file-client-types'
import { ParquetRowPager } from './parquet-row-pager'

type ParquetPreviewState = {
  ready: boolean
  header: string[]
  rowCount: number
  sample: string[][]
  rows: Map<number, string[]>
  error: unknown
}

const initialState = (): ParquetPreviewState => ({
  ready: false,
  header: [],
  rowCount: 0,
  sample: [],
  rows: new Map(),
  error: null
})

export function useParquetPreview(readArgs: RuntimeFileReadArgs, byteSize: number | undefined) {
  const [state, setState] = useState(initialState)
  const requestRows = useRef<(first: number, last: number) => void>(() => {})
  useEffect(() => {
    let canceled = false
    let pager: ParquetRowPager | null = null
    const fail = (error: unknown): void => {
      if (!canceled) {
        requestRows.current = () => {}
        setState((previous) => ({ ...previous, error }))
      }
    }
    const showRows = (rows: Map<number, string[]>): void => {
      if (!canceled) {
        setState((previous) => ({ ...previous, rows }))
      }
    }
    setState(initialState())
    void (async () => {
      const opened = await ParquetRowPager.open(readArgs, byteSize)
      if (canceled) {
        return
      }
      pager = opened
      const rows = await opened.firstRows()
      if (canceled) {
        return
      }
      setState({
        ready: true,
        header: opened.header,
        rowCount: opened.rowCount,
        sample: Array.from({ length: Math.min(200, rows.size) }, (_, index) => rows.get(index)!),
        rows,
        error: null
      })
      requestRows.current = (first, last) => {
        void opened.request(first, last, showRows).catch(fail)
      }
    })().catch(fail)
    return () => {
      canceled = true
      requestRows.current = () => {}
      pager?.close()
    }
  }, [readArgs, byteSize])
  const onVisibleRows = useCallback(
    (first: number, last: number) => requestRows.current(first, last),
    []
  )
  const getRow = useCallback((index: number) => state.rows.get(index), [state.rows])
  return { ...state, onVisibleRows, getRow }
}

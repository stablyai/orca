import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  readCsvColumnWidths,
  writeCsvColumnWidths,
  type CsvColumnWidths
} from './csv-column-width-preferences'

export function useCsvColumnWidths(key: string) {
  const [state, setState] = useState(() => ({ key, widths: readCsvColumnWidths(key) }))
  const pending = useRef<{ key: string; widths: CsvColumnWidths } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flush = useCallback((): void => {
    if (timer.current !== null) {
      clearTimeout(timer.current)
    }
    timer.current = null
    if (pending.current) {
      writeCsvColumnWidths(pending.current.key, pending.current.widths)
    }
    pending.current = null
  }, [])
  useEffect(() => flush, [flush])
  const widths = useMemo(
    () => (state.key === key ? state.widths : readCsvColumnWidths(key)),
    [state, key]
  )
  const changeWidths = (next: CsvColumnWidths): void => {
    if (pending.current && pending.current.key !== key) {
      flush()
    }
    setState({ key, widths: next })
    pending.current = { key, widths: next }
    if (timer.current !== null) {
      clearTimeout(timer.current)
    }
    timer.current = setTimeout(flush, 200)
  }
  return { widths, changeWidths }
}

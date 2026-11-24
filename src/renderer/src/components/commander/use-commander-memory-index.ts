import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { installWindowVisibilityInterval } from '@/lib/window-activity/window-visibility-interval'
import type {
  CommanderAccount,
  CommanderMemoryIndexQuery,
  CommanderMemoryIndexResult
} from '../../../../shared/commander/memory-contract'

export function useMemorySearch(input: string): string {
  const [query, setQuery] = useState(input.trim())
  useEffect(() => {
    const timer = setTimeout(() => setQuery(input.trim()), 200)
    return () => clearTimeout(timer)
  }, [input])
  return query
}

type Batch = {
  filters: CommanderMemoryIndexQuery
  cursors: string[]
  result: CommanderMemoryIndexResult
}

export function useCommanderMemoryIndex(
  account: CommanderAccount,
  filters: CommanderMemoryIndexQuery,
  active: boolean
) {
  const t = useTranslate()
  const [batch, setBatch] = useState<Batch | null>(null)
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const last = useRef<Batch | null>(null)
  const request = useRef<symbol | null>(null)
  const read = useCallback(
    async (navigate?: string[]) => {
      if (request.current) {
        return
      }
      const ticket = Symbol()
      request.current = ticket
      const cursors = navigate ?? (last.current?.filters === filters ? last.current.cursors : [])
      setPending(true)
      setError('')
      try {
        const after = cursors.at(-1)
        const result = await window.api.commanderMemory.index(
          account,
          after ? { ...filters, after } : filters
        )
        if (request.current === ticket) {
          const current = { filters, cursors, result }
          last.current = current
          setBatch(current)
        }
      } catch (reason) {
        if (request.current === ticket) {
          setError(
            reason instanceof Error
              ? reason.message
              : t('commander.memory.listError', 'Could not load memory pages.')
          )
        }
      }
      if (request.current === ticket) {
        request.current = null
        setPending(false)
      }
    },
    [account, filters, t]
  )
  useEffect(() => {
    if (!active) {
      return
    }
    const stop = installWindowVisibilityInterval({
      run: () => void read(),
      intervalMs: 30_000,
      slowWhileUnfocused: true
    })
    return () => {
      request.current = null
      stop()
    }
  }, [active, read])

  const visible = batch?.filters === filters ? batch : null
  const next = visible?.result.next
  return {
    pages: visible?.result.pages ?? [],
    projects: batch?.result.projects ?? [],
    loaded: !!visible,
    error,
    pending,
    previous: visible?.cursors.length ? () => void read(visible.cursors.slice(0, -1)) : undefined,
    next: visible && next ? () => void read([...visible.cursors, next]) : undefined,
    refresh: () => void read()
  }
}

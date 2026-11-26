import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { installWindowVisibilityInterval } from '@/lib/window-activity/window-visibility-interval'
import type {
  CommanderAccount,
  CommanderMemoryIndexResult,
  CommanderMemorySummary
} from '../../../../shared/commander/memory-contract'

export function useCommanderPageSummaries(account: CommanderAccount, ids: string[]) {
  const t = useTranslate()
  const [result, setResult] = useState<{
    account: CommanderAccount
    ids: string[]
    pages: CommanderMemorySummary[]
    error: string
  }>()
  const request = useRef<symbol | null>(null)
  const refresh = useCallback(async () => {
    const ticket = Symbol()
    request.current = ticket
    try {
      const requests: Promise<CommanderMemoryIndexResult>[] = []
      for (let i = 0; i < ids.length; i += 50) {
        requests.push(
          window.api.commanderMemory.index(account, {
            ids: ids.slice(i, i + 50),
            includeDeleted: true
          })
        )
      }
      const batches = await Promise.all(requests)
      if (ticket === request.current) {
        request.current = null
        setResult({ account, ids, pages: batches.flatMap((batch) => batch.pages), error: '' })
      }
    } catch (reason) {
      if (ticket === request.current) {
        request.current = null
        const error =
          reason instanceof Error
            ? reason.message
            : t('commander.memory.listError', 'Could not load memory pages.')
        setResult((previous) => ({
          account,
          ids,
          error,
          pages: previous?.account === account && previous.ids === ids ? previous.pages : []
        }))
      }
    }
  }, [account, ids, t])
  useEffect(() => {
    if (ids.length === 0) {
      return
    }
    const stop = installWindowVisibilityInterval({
      run: () => {
        if (request.current === null) {
          void refresh()
        }
      },
      intervalMs: 30_000,
      slowWhileUnfocused: true
    })
    return () => {
      request.current = null
      stop()
    }
  }, [ids, refresh])
  const current = result?.account === account && result.ids === ids ? result : undefined
  return { pages: current?.pages ?? [], error: current?.error ?? '', refresh }
}

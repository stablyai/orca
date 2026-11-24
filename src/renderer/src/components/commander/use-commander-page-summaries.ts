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
  const [pages, setPages] = useState<CommanderMemorySummary[]>([])
  const [error, setError] = useState('')
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
        setPages(batches.flatMap((batch) => batch.pages))
        setError('')
      }
    } catch (reason) {
      if (ticket === request.current) {
        setError(
          reason instanceof Error
            ? reason.message
            : t('commander.memory.listError', 'Could not load memory pages.')
        )
      }
    }
  }, [account, ids, t])
  useEffect(() => {
    if (ids.length === 0) {
      return
    }
    const stop = installWindowVisibilityInterval({
      run: () => void refresh(),
      intervalMs: 30_000,
      slowWhileUnfocused: true
    })
    return () => {
      request.current = null
      stop()
    }
  }, [ids, refresh])
  return { pages, error, refresh }
}

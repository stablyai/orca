import type * as React from 'react'
import { messageQuestionPrompt, type MessageQuestionView } from '../message-question-occurrence'

/** A Cancel owns only its displayed IDs; an older failed action cannot reveal a newer Cancel. */
export function createUseMessageQuestionCancel({
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
}: Pick<typeof React, 'useCallback' | 'useLayoutEffect' | 'useMemo' | 'useRef' | 'useState'>) {
  return function useMessageQuestionCancel(args: {
    sourceKey: string
    view?: MessageQuestionView
    cancel?: (ids: readonly string[]) => Promise<void>
    error: () => void
  }) {
    const owner = useMemo(() => ({ sourceKey: args.sourceKey }), [args.sourceKey])
    const active = useRef<object | null>(null)
    const [masks, setMasks] = useState<{ owner: object; ids: ReadonlyMap<string, object> }>()
    useLayoutEffect(() => {
      active.current = owner
      return () => {
        active.current = null
      }
    }, [owner])
    const records = args.view?.records
    const ready = args.view?.ready === true
    useLayoutEffect(() => {
      if (ready && records) {
        const pending = new Set(records.map((record) => record.id))
        setMasks((previous) => {
          if (previous?.owner !== owner) {
            return previous
          }
          const ids = new Map([...previous.ids].filter(([id]) => pending.has(id)))
          return ids.size === previous.ids.size ? previous : { owner, ids }
        })
      }
    }, [owner, ready, records])
    const hidden = useMemo(
      () => new Set(masks?.owner === owner ? masks.ids.keys() : []),
      [masks, owner]
    )
    const prompt = useMemo(
      () => (records ? messageQuestionPrompt(records, hidden) : null),
      [records, hidden]
    )
    const { cancel, error } = args
    const cancelDisplayed = useCallback(
      async (ids: readonly string[]): Promise<boolean> => {
        if (active.current !== owner || !ready || !cancel || ids.length === 0) {
          return false
        }
        const attempt = {}
        setMasks((previous) => {
          const next = new Map(previous?.owner === owner ? previous.ids : [])
          ids.forEach((id) => next.set(id, attempt))
          return { owner, ids: next }
        })
        try {
          await cancel(ids)
          return active.current === owner
        } catch {
          if (active.current === owner) {
            setMasks((previous) => {
              if (previous?.owner !== owner) {
                return previous
              }
              const next = new Map(previous.ids)
              ids.forEach((id) => {
                if (next.get(id) === attempt) {
                  next.delete(id)
                }
              })
              return { owner, ids: next }
            })
            error()
          }
          return false
        }
      },
      [owner, ready, cancel, error]
    )
    return { prompt, cancel: cancelDisplayed, ready }
  }
}

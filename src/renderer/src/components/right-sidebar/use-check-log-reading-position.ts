import { useLayoutEffect, useMemo, useRef } from 'react'
import type { PRCheckJob } from '../../../../shared/github/check-types'
import { scrollTopCache } from '@/lib/scroll-cache'
import {
  checkLogDigest,
  checkReadingIntentKey,
  checkReadingLogKey
} from '@/components/editor/check-details-reading-cache'
import type { CheckDetailsReadingOwner } from '@/components/editor/check-details-reading-owner'
import { attachCheckReadingViewport } from '@/components/editor/check-details-reading-viewport'
import {
  findInitialCheckLogDiagnostic,
  measureInitialCheckLogScrollTop
} from './check-log-initial-diagnostic-position'

export function useCheckLogReadingPosition(
  logTail: string | null,
  expanded: boolean,
  job: string,
  owner?: CheckDetailsReadingOwner,
  logState?: PRCheckJob['logState']
) {
  const text = logTail ?? ''
  const pendingError = !text && logState === 'error'
  const ref = useRef<HTMLPreElement>(null)
  const localIntent = useRef(Boolean(text) || logState === 'error')
  const localPosition = useRef<number | undefined>(undefined)
  const digest = useMemo(() => (expanded && text ? checkLogDigest(text) : ''), [expanded, text])
  useLayoutEffect(() => {
    const pre = ref.current
    if (expanded && !text) {
      if (!pendingError) {
        localIntent.current = false
        return
      }
      return owner?.register({
        job,
        text: logTail,
        start: () => {
          owner.claim(job)
        },
        retire: () => undefined,
        cancel: () => {
          localIntent.current = false
        }
      })
    }
    if (!pre || !expanded || !text) {
      return
    }
    return attachCheckReadingViewport({
      node: pre,
      owner,
      job,
      text,
      cacheKey: owner ? checkReadingLogKey(owner.key, job, digest) : undefined,
      localPosition,
      consumeIntent: () => {
        if (owner) {
          if (!owner.claim(job)) {
            return false
          }
          scrollTopCache.delete(checkReadingIntentKey(owner.key, job))
          return true
        }
        const intent = localIntent.current
        localIntent.current = false
        return intent
      },
      initial: () => {
        const anchor = findInitialCheckLogDiagnostic(text)
        return anchor ? measureInitialCheckLogScrollTop(pre, anchor) : 0
      }
    })
  }, [digest, expanded, job, logTail, owner, pendingError, text])
  return ref
}

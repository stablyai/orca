import { useEffect, useMemo, useState } from 'react'
import { parseKaneoTaskUrl } from '../../../../shared/kaneo-task-url'
import type { KaneoTask } from '../../../../shared/kaneo-types'
import { lookupKaneoTask, type KaneoRuntimeSettings } from '@/runtime/runtime-kaneo-client'
import { getProviderRuntimeContextKey } from '@/lib/provider-runtime-context'

export function useKaneoUrlSource(value: string, enabled: boolean, settings: KaneoRuntimeSettings) {
  const intent = useMemo(() => (enabled ? parseKaneoTaskUrl(value) : null), [value, enabled])
  const contextKey = getProviderRuntimeContextKey(settings)
  const environmentId = settings?.activeRuntimeEnvironmentId
  const key = intent ? `${contextKey}:${intent.url}` : null
  const [attempt, setAttempt] = useState(0)
  // A → B → A must not revive the response from the first lookup.
  const requestKey = useMemo(() => ({ key, intent, attempt }), [key, intent, attempt])
  const [result, setResult] = useState<{
    requestKey: typeof requestKey
    task: KaneoTask | null
    error: string | null
  } | null>(null)
  useEffect(() => {
    if (!key || !intent) {
      return
    }
    let cancelled = false
    const controller = new AbortController()
    const timer = setTimeout(() => {
      void lookupKaneoTask(
        { activeRuntimeEnvironmentId: environmentId },
        intent.url,
        controller.signal
      ).then(
        (task) => {
          if (!cancelled) {
            setResult({ requestKey, task, error: null })
          }
        },
        (error: unknown) => {
          if (!cancelled) {
            setResult({
              requestKey,
              task: null,
              error: error instanceof Error ? error.message : 'Could not load the Kaneo task.'
            })
          }
        }
      )
    }, 200)
    return () => {
      cancelled = true
      controller.abort()
      clearTimeout(timer)
    }
  }, [key, intent, environmentId, requestKey])
  const current = result?.requestKey === requestKey ? result : null
  return {
    intent,
    task: current?.task ?? null,
    error: current?.error ?? null,
    loading: key !== null && current === null,
    retry: () => setAttempt((value) => value + 1)
  }
}

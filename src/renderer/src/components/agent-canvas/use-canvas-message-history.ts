import { useEffect, useState } from 'react'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { canvasMessageSchema, type CanvasMessage } from '../../../../shared/canvas-messaging'
import { resolveTarget } from './canvas-runtime-target'

export function useCanvasMessageHistory(scope?: string) {
  const [state, setState] = useState<{
    messages: CanvasMessage[]
    loading: boolean
    error: string | null
  }>({ messages: [], loading: true, error: null })
  useEffect(() => {
    let active = true
    let refreshing = false
    const controller = new AbortController()
    setState({ messages: [], loading: true, error: null })
    const refresh = async () => {
      if (refreshing) {
        return
      }
      refreshing = true
      try {
        const target = scope ? resolveTarget(scope) : null
        if (!target) {
          throw new Error('Reconnect the workspace to view messages.')
        }
        const result = await callRuntimeRpc<{ messages: unknown }>(
          target,
          'canvas.history',
          {
            canvasId: scope
          },
          { signal: controller.signal, timeoutMs: 5000, suppressFeatureInteraction: true }
        )
        const messages = canvasMessageSchema.array().parse(result.messages)
        if (active) {
          setState({ messages, loading: false, error: null })
        }
      } catch (error) {
        if (active) {
          setState((value) => ({
            ...value,
            loading: false,
            error: error instanceof Error ? error.message : 'Message history is unavailable.'
          }))
        }
      } finally {
        refreshing = false
      }
    }
    void refresh()
    // Hidden canvases skip polling; a visibility change refreshes on return.
    const onVisibility = () => {
      if (typeof document !== 'undefined' && !document.hidden) {
        void refresh()
      }
    }
    const timer = setInterval(() => {
      if (typeof document === 'undefined' || !document.hidden) {
        void refresh()
      }
    }, 2000)
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibility)
    }
    return () => {
      active = false
      controller.abort()
      clearInterval(timer)
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility)
      }
    }
  }, [scope])
  return state
}

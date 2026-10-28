import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import {
  CLAUDE_AGENT_VIEW_SUBSCRIBE,
  ClaudeAgentViewSnapshot
} from '../../../shared/claude-agent-view'
import { subscribeRuntimeRpc } from './runtime-rpc-subscribe'

type Resource = {
  snapshot: ClaudeAgentViewSnapshot
  listeners: Set<() => void>
  dispose: () => void
}

const EMPTY: ClaudeAgentViewSnapshot = []
const resources = new Map<string, Resource>()

export function readClaudeAgentViews(key: string): ClaudeAgentViewSnapshot {
  return resources.get(key)?.snapshot ?? EMPTY
}

export function subscribeClaudeAgentViews(
  key: string,
  target: RuntimeClientTarget,
  listener: () => void
): () => void {
  let resource = resources.get(key)
  if (!resource) {
    resource = { snapshot: EMPTY, listeners: new Set(), dispose: () => {} }
    resources.set(key, resource)
    const held = resource
    let close: (() => void) | undefined
    let retry: ReturnType<typeof setTimeout> | undefined
    let generation = 0
    const publish = (snapshot: ClaudeAgentViewSnapshot): void => {
      held.snapshot = snapshot
      held.listeners.forEach((notify) => notify())
    }
    const open = (): void => {
      const attempt = ++generation
      const live = () => resources.get(key) === held && generation === attempt
      const lose = (error?: unknown): void => {
        if (!live()) {
          return
        }
        generation += 1
        close?.()
        close = undefined
        publish(EMPTY)
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          (error.code === 'method_not_found' || error.code === 'forbidden')
        ) {
          return
        }
        retry = setTimeout(open, 5000)
      }
      void subscribeRuntimeRpc(target, CLAUDE_AGENT_VIEW_SUBSCRIBE, null, {
        onEvent: (frame) => {
          const parsed = ClaudeAgentViewSnapshot.safeParse(frame)
          if (live() && parsed.success) {
            publish(parsed.data)
          }
        },
        onError: lose,
        onClose: lose
      }).then((handle) => {
        if (live()) {
          close = handle.unsubscribe
        } else {
          handle.unsubscribe()
        }
      }, lose)
    }
    held.dispose = () => {
      generation += 1
      clearTimeout(retry)
      close?.()
    }
    open()
  }
  const held = resource
  held.listeners.add(listener)
  return () => {
    held.listeners.delete(listener)
    queueMicrotask(() => {
      if (held.listeners.size === 0 && resources.get(key) === held) {
        resources.delete(key)
        held.dispose()
      }
    })
  }
}

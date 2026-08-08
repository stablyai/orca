import { Loader2 } from 'lucide-react'
import { useEffect, useId, useState, useSyncExternalStore } from 'react'
import type {
  SessionOptionDescriptor,
  SessionOptionsSurface
} from '../../../../shared/native-chat-session-options'
import type { AgentSessionContextSnapshot } from '../../../../shared/agent-session-context'

let openControlId: string | null = null
const openControlListeners = new Set<() => void>()

function setOpenControlId(id: string | null): void {
  if (openControlId === id) {
    return
  }
  openControlId = id
  for (const listener of openControlListeners) {
    listener()
  }
}

export function useExclusiveSessionControlMenu(): {
  open: boolean
  setOpen: (open: boolean) => void
} {
  const id = useId()
  const open = useSyncExternalStore(
    (listener) => {
      openControlListeners.add(listener)
      return () => openControlListeners.delete(listener)
    },
    () => openControlId === id,
    () => false
  )
  useEffect(
    () => () => {
      if (openControlId === id) {
        setOpenControlId(null)
      }
    },
    [id]
  )
  return {
    open,
    setOpen: (next) => {
      if (next) {
        setOpenControlId(id)
      } else if (openControlId === id) {
        setOpenControlId(null)
      }
    }
  }
}

export function SynchronizedSpinner(): React.JSX.Element {
  return (
    <Loader2
      className="size-4 animate-spin"
      style={{ animationDelay: `${-(Date.now() % 1_000)}ms` }}
    />
  )
}

export function contextForSelectedWindow(
  context: AgentSessionContextSnapshot,
  options: readonly SessionOptionDescriptor[]
): AgentSessionContextSnapshot {
  const descriptor = options.find(({ id }) => id === 'contextWindow')
  const value = descriptor?.kind.type === 'select' ? descriptor.kind.currentValue : undefined
  const maxTokens = value === '1m' ? 1_000_000 : value === 'standard' ? 200_000 : null
  if (maxTokens === null || maxTokens === context.maxTokens) {
    return context
  }
  const usedTokens = context.usedTokens
  return {
    ...context,
    maxTokens,
    remainingTokens: usedTokens === null ? null : Math.max(0, maxTokens - usedTokens),
    usedPercent: usedTokens === null ? null : (usedTokens / maxTokens) * 100
  }
}

export function CustomModelInput(props: {
  pending: boolean
  onSubmit: (modelId: string) => Promise<boolean>
}): React.JSX.Element {
  const [value, setValue] = useState('')
  const submit = (): void => {
    const modelId = value.trim()
    if (!modelId || props.pending) {
      return
    }
    void props.onSubmit(modelId).then((applied) => {
      if (applied) {
        setValue('')
      }
    })
  }
  return (
    <div className="p-1.5 pt-1">
      <input
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key === 'Enter') {
            event.preventDefault()
            submit()
          }
        }}
        disabled={props.pending}
        aria-label="Custom model"
        placeholder="Custom model…"
        className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm outline-none placeholder:text-muted-foreground focus:border-ring disabled:opacity-50"
      />
    </div>
  )
}

function modelIsConfirmed(snapshot: SessionOptionDescriptor[], modelId: string): boolean {
  const model = snapshot.find((descriptor) => descriptor.id === 'model')
  return (
    model?.kind.type === 'select' &&
    model.kind.currentValue === modelId &&
    model.valueSource !== 'dispatched' &&
    model.valueSource !== 'unknown'
  )
}

export function waitForConfirmedModel(
  surface: SessionOptionsSurface,
  modelId: string,
  snapshot: SessionOptionDescriptor[]
): Promise<boolean> {
  if (modelIsConfirmed(snapshot, modelId)) {
    return Promise.resolve(true)
  }
  return new Promise((resolve) => {
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | null = null
    let unsubscribe = (): void => {}
    const finish = (confirmed: boolean): void => {
      if (settled) {
        return
      }
      settled = true
      if (timeout) {
        clearTimeout(timeout)
      }
      unsubscribe()
      resolve(confirmed)
    }
    unsubscribe = surface.subscribe((next) => {
      if (modelIsConfirmed(next, modelId)) {
        finish(true)
      }
    })
    timeout = setTimeout(() => finish(false), 6_000)
  })
}

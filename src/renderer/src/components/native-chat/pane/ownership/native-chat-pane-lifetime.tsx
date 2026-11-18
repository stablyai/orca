import {
  createContext,
  useCallback,
  useRef,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useState,
  type EffectCallback
} from 'react'

type LifetimeEffect = EffectCallback
type Connection = {
  effect: LifetimeEffect
  dispose: ReturnType<EffectCallback>
  connected: boolean
}

class PaneLifetime {
  private visible = true
  setVisible(visible: boolean): void {
    this.visible = visible
  }
  private connections = new Map<string, Connection>()
  private generation = 0

  private remove(id: string, connection: Connection): void {
    if (this.connections.get(id) === connection) {
      this.connections.delete(id)
      connection.dispose?.()
    }
  }

  connect(id: string, effect: LifetimeEffect): () => void {
    let connection = this.connections.get(id)
    if (connection && connection.effect !== effect) {
      this.remove(id, connection)
      connection = undefined
    }
    connection ??= { effect, dispose: effect(), connected: true }
    connection.connected = true
    this.connections.set(id, connection)
    const current = connection
    return () => {
      current.connected = false
      queueMicrotask(() => {
        if (this.visible && !current.connected) {
          this.remove(id, current)
        }
      })
    }
  }

  prune = (): void => {
    if (this.visible) {
      for (const [id, connection] of this.connections) {
        if (!connection.connected) {
          this.remove(id, connection)
        }
      }
    }
  }

  retain = (): (() => void) => {
    const generation = ++this.generation
    return () => {
      queueMicrotask(() => {
        if (generation === this.generation) {
          for (const [id, connection] of this.connections) {
            this.remove(id, connection)
          }
        }
      })
    }
  }
}

const Lifetime = createContext<PaneLifetime | null>(null)

/** Own only conversation lifetimes here; subscriptions and DOM effects stay inside Activity. */
export function NativeChatPaneLifetime({
  isVisible,
  children
}: {
  isVisible: boolean
  children: React.ReactNode
}) {
  const [owner] = useState(() => new PaneLifetime())
  useLayoutEffect(() => {
    owner.setVisible(isVisible)
  }, [isVisible, owner])
  useEffect(() => owner.retain(), [owner])
  useEffect(() => {
    queueMicrotask(owner.prune)
  }, [isVisible, owner])
  return <Lifetime value={owner}>{children}</Lifetime>
}

export function useNativeChatPaneLifetimeEffect(setup: EffectCallback) {
  const owner = useContext(Lifetime)
  const id = useId()
  useEffect(() => (owner ? owner.connect(id, setup) : setup()), [setup, id, owner])
}

export function useNativeChatPaneMountedRef() {
  const mounted = useRef(true)
  useNativeChatPaneLifetimeEffect(
    useCallback(() => {
      mounted.current = true
      return () => {
        mounted.current = false
      }
    }, [])
  )
  return mounted
}

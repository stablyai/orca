import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { PluginDeclarativeNode } from '../../../../shared/plugins/declarative/plugin-declarative-catalog'
import type { PluginDeclarativeEventArg } from '../../../../shared/plugins/declarative/plugin-declarative-messages'
import { PLUGIN_DECLARATIVE_MESSAGES } from '../../../../shared/plugins/declarative/plugin-declarative-message-names'

/**
 * What `orca plugin shot` drives and waits on in a mounted components panel: the tree on screen,
 * the guest callbacks Orca's own controls fire, and the host calls in flight. Sends carry no
 * press, so they never grant a gesture.
 */
export type PluginPanelActDriver = {
  /** The tree React last committed for this panel. */
  tree(): PluginDeclarativeNode | null
  send(callback: string, args: PluginDeclarativeEventArg[]): void
  /** Host calls (`plugin.request` included) the panel is still waiting on. */
  pending(): number
  /** Called after each committed tree and each change in `pending()`. */
  onChange(listener: () => void): () => void
  /** Asks the guest to remember its atoms before `--act`. */
  snapshot(): void
  /** Puts them back and redraws Orca's controls; false when that guest is gone (a reload). */
  restore(): boolean
}

const drivers = new Map<string, PluginPanelActDriver>()

export function pluginPanelActDriver(tabKey: string): PluginPanelActDriver | null {
  return drivers.get(tabKey) ?? null
}

/**
 * Registers the panel for `tabKey` while it is mounted. `viewEpoch` keys Orca's drawn view, so a
 * restore also resets what its controls hold locally; `trackHostCall` goes to the frame host.
 */
export function usePluginPanelActDriver(options: {
  tabKey: string
  tree: PluginDeclarativeNode | null
  document: string | null
  send: (callback: string, args: PluginDeclarativeEventArg[]) => void
  sendToGuest: (event: string, payload: unknown) => void
}): { viewEpoch: number; trackHostCall: () => () => void } {
  const { tabKey, tree } = options
  const [viewEpoch, setViewEpoch] = useState(0)
  const latest = useRef(options)
  const treeRef = useRef(tree)
  const [listeners] = useState(() => new Set<() => void>())
  const pendingRef = useRef(0)
  useLayoutEffect(() => {
    latest.current = options
  })
  useLayoutEffect(() => {
    treeRef.current = tree
    listeners.forEach((listener) => listener())
  }, [listeners, tree])
  const trackHostCall = useMemo(
    () => () => {
      pendingRef.current += 1
      listeners.forEach((listener) => listener())
      let done = false
      return () => {
        if (!done) {
          done = true
          pendingRef.current -= 1
          listeners.forEach((listener) => listener())
        }
      }
    },
    [listeners]
  )
  useLayoutEffect(() => {
    let snapshotOf: string | null = null
    const driver: PluginPanelActDriver = {
      tree: () => treeRef.current,
      send: (callback, args) => latest.current.send(callback, args),
      pending: () => pendingRef.current,
      onChange: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      snapshot: () => {
        snapshotOf = latest.current.document
        if (snapshotOf) {
          latest.current.sendToGuest(PLUGIN_DECLARATIVE_MESSAGES.snapshot, { document: snapshotOf })
        }
      },
      restore: () => {
        const document = snapshotOf
        snapshotOf = null
        if (!document || document !== latest.current.document) {
          return false
        }
        latest.current.sendToGuest(PLUGIN_DECLARATIVE_MESSAGES.restore, { document })
        setViewEpoch((epoch) => epoch + 1)
        return true
      }
    }
    drivers.set(tabKey, driver)
    return () => {
      if (drivers.get(tabKey) === driver) {
        drivers.delete(tabKey)
      }
    }
  }, [listeners, tabKey])
  return { viewEpoch, trackHostCall }
}

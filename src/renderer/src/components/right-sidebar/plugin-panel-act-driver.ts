import { useLayoutEffect, useRef } from 'react'
import type { PluginDeclarativeNode } from '../../../../shared/plugins/declarative/plugin-declarative-catalog'
import type { PluginDeclarativeEventArg } from '../../../../shared/plugins/declarative/plugin-declarative-messages'

/**
 * What `orca plugin shot --act` drives on a mounted components panel: the tree on screen and the
 * guest callbacks Orca's own controls fire. Sends carry no press, so they never grant a gesture.
 */
export type PluginPanelActDriver = {
  /** The tree React last committed for this panel. */
  tree(): PluginDeclarativeNode | null
  send(callback: string, args: PluginDeclarativeEventArg[]): void
  /** Called after each tree this panel commits. */
  onDraw(listener: () => void): () => void
}

const drivers = new Map<string, PluginPanelActDriver>()

export function pluginPanelActDriver(tabKey: string): PluginPanelActDriver | null {
  return drivers.get(tabKey) ?? null
}

/** Registers the panel for `tabKey` while it is mounted. */
export function usePluginPanelActDriver(
  tabKey: string,
  tree: PluginDeclarativeNode | null,
  send: (callback: string, args: PluginDeclarativeEventArg[]) => void
): void {
  const treeRef = useRef(tree)
  const sendRef = useRef(send)
  const listenersRef = useRef(new Set<() => void>())
  useLayoutEffect(() => {
    sendRef.current = send
  })
  useLayoutEffect(() => {
    treeRef.current = tree
    for (const listener of listenersRef.current) {
      listener()
    }
  }, [tree])
  useLayoutEffect(() => {
    const listeners = listenersRef.current
    const driver: PluginPanelActDriver = {
      tree: () => treeRef.current,
      send: (callback, args) => sendRef.current(callback, args),
      onDraw: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    }
    drivers.set(tabKey, driver)
    return () => {
      if (drivers.get(tabKey) === driver) {
        drivers.delete(tabKey)
      }
    }
  }, [tabKey])
}

import { hostAtom, hydrateAtoms } from './declarative-atoms'
import { readHostMessage, readStoredValues } from './declarative-host-messages'
import type { OrcaPanelContext } from './declarative-runtime-types'

/** The `setup(ctx)` context, and hydration: panel id, visibility and persisted atoms from Orca. */
export function createPanelContext() {
  const visibility = hostAtom(true)
  const lifetime = new AbortController()
  const context: OrcaPanelContext = {
    subscriptions: [],
    signal: lifetime.signal,
    visible: visibility.atom,
    panel: { id: '' }
  }
  let hydratedNow = false
  let resolve: () => void = () => undefined
  const hydrated = new Promise<void>((done) => {
    resolve = () => {
      hydratedNow = true
      done()
    }
  })

  function setVisibility(payload: unknown): void {
    const { visible } = readHostMessage(payload)
    if (typeof visible === 'boolean') {
      visibility.set(visible)
    }
  }

  return {
    context,
    hydrated,
    isHydrated: () => hydratedNow,
    markHydrated: () => resolve(),
    setVisibility,
    /** `ui.hydrate`: on boot, and again with the new workspace's values after a switch. */
    hydrate(payload: unknown): void {
      const message = readHostMessage(payload)
      if (typeof message.panelId === 'string') {
        context.panel = { id: message.panelId }
      }
      setVisibility(payload)
      for (const scope of ['plugin', 'workspace'] as const) {
        const values = readStoredValues(message[scope])
        if (values) {
          hydrateAtoms(scope, values)
        }
      }
      resolve()
    },
    abort: () => lifetime.abort()
  }
}

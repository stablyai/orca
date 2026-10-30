import type { LegacyRelayBridgeApi } from '../../../../preload/api/legacy-relay-bridge-api'
import type { PtyInputSource, PtyInputSourceObserver } from './pty-input-source'
import { projectLegacyRelayInnerInputSource } from './legacy-relay-inner-input-source'
import type { PtyTransport } from './pty-transport-types'

export function disposeLegacyRelayViewer(
  api: LegacyRelayBridgeApi | undefined,
  ptyId: string,
  viewer: number | null,
  disposers: (() => void)[]
): void {
  let failure: unknown
  for (const dispose of disposers) {
    try {
      dispose()
    } catch (error) {
      failure ??= error
    }
  }
  try {
    if (viewer !== null) {
      api?.detach({ ptyId, acquisitionId: viewer })
    }
  } catch (error) {
    failure ??= error
  }
  if (failure !== undefined) {
    throw failure
  }
}

/** Route lifetime qualifies identity; the selected inner remains the authority for its current token. */
export function createLegacyRelayInputSource(args: {
  ptyId: string
  api: LegacyRelayBridgeApi | undefined
  inner: PtyTransport
  isBridgeWritable: () => boolean
}) {
  type Lifetime = {
    route: 'bridge' | 'inner'
    live: boolean
    owns: () => boolean
    target?: PtyInputSource
    view?: PtyInputSource
  }
  let lifetime: Lifetime | null = null
  let version = 0
  let observer: { value: PtyInputSourceObserver } | null = null
  let observation: { dispose?: () => void } | null = null
  const notify = (callback: () => void): void => {
    try {
      callback()
    } catch (error) {
      console.warn('Terminal input source observer failed', error)
    }
  }
  const current = (): PtyInputSource | null => {
    const selected = lifetime
    if (!selected?.live) {
      return null
    }
    if (selected.route === 'inner') {
      const target = args.inner.getInputSource?.()
      if (!target) {
        return null
      }
      if (selected.target !== target) {
        selected.target = target
        selected.view = projectLegacyRelayInnerInputSource(target, selected.owns)
      }
    } else if (!selected.view) {
      const isCurrent = (): boolean => selected.owns() && args.isBridgeWritable() && !!args.api
      const write = (data: string): boolean => {
        if (!isCurrent() || !args.api) {
          return false
        }
        args.api.write({ ptyId: args.ptyId, data })
        return true
      }
      selected.view = {
        ptyId: args.ptyId,
        isCurrent,
        sendInput: write,
        sendInputImmediate: write,
        sendInputAccepted: async (data) => write(data) && isCurrent()
      }
    }
    return selected.view ?? null
  }
  const publish = (): void => notify(() => observer?.value.afterChange(current()))
  const observeInner = (): void => {
    if (observation || !args.inner.observeInputSource) {
      return
    }
    const registration: { dispose?: () => void } = {}
    observation = registration
    const handle = args.inner.observeInputSource({
      beforeChange: () => {
        if (observation === registration && lifetime?.route === 'inner') {
          notify(() => observer?.value.beforeChange())
        }
      },
      afterChange: () => {
        if (observation === registration && lifetime?.route === 'inner') {
          publish()
        }
      }
    })
    if (observation === registration) {
      registration.dispose = () => handle.dispose()
    } else {
      handle.dispose()
    }
  }
  observeInner()
  return {
    current,
    version: () => version,
    change(next: Lifetime['route'] | null, adopt: () => void, unavailable = false): boolean {
      if (next) {
        observeInner()
      }
      const previous = lifetime
      const at = ++version
      const compatible = previous?.live === true && previous.route === next
      if (!compatible && unavailable && previous) {
        previous.live = false
      }
      if (!compatible && previous) {
        notify(() => observer?.value.beforeChange())
      }
      if (at !== version) {
        return false
      }
      if (!compatible && previous) {
        previous.live = false
      }
      let adopted = false
      try {
        adopt()
        adopted = true
      } finally {
        if (at === version) {
          if (adopted && next && !compatible) {
            const selected: Lifetime = {
              route: next,
              live: true,
              owns: () => selected.live && lifetime === selected
            }
            lifetime = selected
          } else {
            lifetime = adopted && compatible ? previous : null
          }
          if (!adopted && previous) {
            previous.live = false
          }
          if (!compatible) {
            publish()
          }
        }
      }
      return adopted && at === version
    },
    observe(next: PtyInputSourceObserver) {
      const registration = { value: next }
      observer = registration
      notify(() => next.afterChange(current()))
      return {
        dispose: () => {
          if (observer === registration) {
            observer = null
          }
        }
      }
    },
    takeObservation: () => {
      const previous = observation
      observation = null
      return () => previous?.dispose?.()
    }
  }
}

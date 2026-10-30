import type { LegacyRelayBridgeApi } from '../../../../preload/api/legacy-relay-bridge-api'
import { createPtyInputSourceBinding, type PtyInputSource } from './pty-input-source'
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

/** The bridge owns its writer; its unused managed-runtime transport cannot represent it. */
export function createLegacyRelayInputSource(args: {
  ptyId: string
  api: LegacyRelayBridgeApi | undefined
  inner: PtyTransport
  isInner: () => boolean
  isBridgeWritable: () => boolean
}) {
  const source = createPtyInputSourceBinding<'bridge' | PtyInputSource>({
    same: (a, b) => a === b,
    refine: (_, next) => next,
    create: (endpoint, owns) => {
      const target = endpoint()
      if (target === 'bridge') {
        const isCurrent = (): boolean => owns() && args.isBridgeWritable() && !!args.api
        const write = (data: string): boolean => {
          if (!isCurrent() || !args.api) {
            return false
          }
          args.api.write({ ptyId: args.ptyId, data })
          return true
        }
        return {
          ptyId: args.ptyId,
          isCurrent,
          sendInput: write,
          sendInputImmediate: write,
          sendInputAccepted: async (data) => write(data) && isCurrent()
        }
      }
      const isCurrent = (): boolean => owns() && target.isCurrent()
      const accepted = target.sendInputAccepted
      return {
        ptyId: target.ptyId,
        get endpoint() {
          return target.endpoint
        },
        isCurrent,
        sendInput: (data, kind) => isCurrent() && target.sendInput(data, kind),
        sendInputImmediate: (data) => isCurrent() && target.sendInputImmediate(data),
        ...(accepted
          ? {
              sendInputAccepted: async (...params: Parameters<typeof accepted>) =>
                isCurrent() && (await accepted.call(target, ...params)) && isCurrent()
            }
          : {}),
        claimViewport: (cols, rows) => isCurrent() && (target.claimViewport?.(cols, rows) ?? false)
      }
    }
  })
  args.inner.observeInputSource?.({
    beforeChange: () => {
      if (args.isInner()) {
        source.change(null, () => {})
      }
    },
    afterChange: (next) => {
      if (args.isInner()) {
        source.change(next, () => {})
      }
    }
  })
  return source
}

import { vi } from 'vitest'
import {
  createPtyInputSourceBinding,
  type PtyInputSource,
  type PtyInputSourceObserver
} from './pty-input-source'
import type { PtyTransport } from './pty-transport-types'

/** Real producer lifecycle at the lower-transport boundary; writes keep their captured token. */
export function createLegacyRelayTestInner(accepted = true) {
  const writes: string[] = []
  const acceptedCalls: Parameters<NonNullable<PtyInputSource['sendInputAccepted']>>[] = []
  const acceptance = Promise.withResolvers<boolean>()
  const disposed = vi.fn()
  let registrations = 0
  let onDispose = (): void => {}
  const source = createPtyInputSourceBinding<{ incarnation: string | null }>({
    same: (a, b) => !a.incarnation || !b.incarnation || a.incarnation === b.incarnation,
    refine: (a, b) => ({ incarnation: b.incarnation ?? a.incarnation }),
    unavailable: (a, b) => !!a.incarnation && !!b.incarnation && a.incarnation !== b.incarnation,
    create: (endpoint, owns) => {
      const target: PtyInputSource = {
        ptyId: 'remote:env-1@@t-1',
        get endpoint() {
          return { handle: 't-1', incarnationId: endpoint().incarnation }
        },
        isCurrent: owns,
        sendInput(data) {
          expectReceiver(this)
          if (!owns()) {
            return false
          }
          writes.push(data)
          return true
        },
        sendInputImmediate(data) {
          return this.sendInput(data, 'query-reply')
        },
        ...(accepted
          ? {
              async sendInputAccepted(
                this: PtyInputSource,
                ...params: Parameters<NonNullable<PtyInputSource['sendInputAccepted']>>
              ) {
                const [data] = params
                acceptedCalls.push(params)
                expectReceiver(this)
                if (!owns()) {
                  return false
                }
                writes.push(data)
                return acceptance.promise
              },
              claimViewport(this: PtyInputSource, cols: number, rows: number) {
                expectReceiver(this)
                if (!owns()) {
                  return false
                }
                writes.push(`claim:${cols}x${rows}`)
                return true
              }
            }
          : {})
      }
      function expectReceiver(receiver: PtyInputSource): void {
        if (receiver !== target) {
          throw new Error('Lost original source receiver')
        }
      }
      return target
    }
  })
  source.change({ incarnation: null }, () => {})
  const readSource = vi.fn(source.current)
  const observeSource = vi.fn((observer: PtyInputSourceObserver) => {
    registrations++
    const handle = source.observe(observer)
    return {
      dispose: () => {
        registrations--
        handle.dispose()
        disposed()
        onDispose()
      }
    }
  })
  const transport: PtyTransport = {
    connect: vi.fn(async () => 'remote:env-1@@t-1'),
    attach: vi.fn(() => source.change({ incarnation: null }, () => {})),
    disconnect: () => source.change(null, () => {}, true),
    detach: vi.fn(() => source.change(null, () => {}, true)),
    destroy: vi.fn(() => {
      source.change(null, () => {}, true)
    }),
    getInputSource: readSource,
    observeInputSource: observeSource,
    sendInput: (data, kind) => source.current()?.sendInput(data, kind) ?? false,
    sendInputImmediate: (data) => source.current()?.sendInputImmediate(data) ?? false,
    resize: () => false,
    isConnected: () => source.current() !== null,
    getPtyId: () => source.current()?.ptyId ?? null
  }
  return {
    source,
    transport,
    writes,
    acceptance,
    acceptedCalls,
    disposed,
    readSource,
    observeSource,
    registrations: () => registrations,
    onDispose: (callback: () => void) => {
      onDispose = callback
    }
  }
}

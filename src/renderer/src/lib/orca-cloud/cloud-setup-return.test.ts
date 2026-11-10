import { afterEach, describe, expect, it, vi } from 'vitest'
import { onCloudSetupReturn } from './cloud-setup-return'

type Emit = (event: { sessionId: string }) => void

function installBridge(): { emit: Emit; dispose: ReturnType<typeof vi.fn> } {
  let emit: Emit = () => {}
  const dispose = vi.fn()
  vi.stubGlobal('window', {
    api: {
      orcaProfiles: {
        onCloudSetupReturn: (callback: Emit) => {
          emit = callback
          return dispose
        }
      }
    }
  })
  return { emit: (event) => emit(event), dispose }
}

describe('onCloudSetupReturn', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('fans one IPC subscription out to every listener and releases it with the last one', () => {
    const bridge = installBridge()
    const first = vi.fn()
    const second = vi.fn()
    const offFirst = onCloudSetupReturn(first)
    const offSecond = onCloudSetupReturn(second)
    bridge.emit({ sessionId: 'cs_x' })
    expect(first).toHaveBeenCalledWith('cs_x')
    expect(second).toHaveBeenCalledWith('cs_x')
    offFirst()
    expect(bridge.dispose).not.toHaveBeenCalled()
    offSecond()
    expect(bridge.dispose).toHaveBeenCalledTimes(1)
  })

  it('is a no-op without the bridge (web client, tests)', () => {
    vi.stubGlobal('window', {})
    const off = onCloudSetupReturn(vi.fn())
    expect(() => off()).not.toThrow()
  })
})

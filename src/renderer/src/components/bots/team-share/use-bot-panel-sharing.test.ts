// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { SharedBotHostsState } from '../../../../../shared/bots/shared-bot-hosts'
import { installSharedBotHostCatalog } from '@/runtime/hosts/shared-bot-hosts/shared-bot-host-catalog'
import { useBotPanelSharing } from './use-bot-panel-sharing'

let changed: (state: SharedBotHostsState) => void = () => {}
let uninstall = (): void => {}

afterEach(() => {
  uninstall()
  Reflect.deleteProperty(window, 'api')
})

describe('the agent panel’s Share… dialog', () => {
  it('closes for good when the cloud stops taking shares', async () => {
    Reflect.set(window, 'api', {
      sharedBotHosts: {
        list: async () => ({ hosts: [], sharing: true }),
        onChanged: (listener: typeof changed) => {
          changed = listener
          return () => {}
        }
      }
    })
    await act(async () => {
      uninstall = installSharedBotHostCatalog()
    })
    const { result } = renderHook(() => useBotPanelSharing())
    act(() => result.current.setSharing('people'))
    expect(result.current.sharing).toBe('people')
    act(() => changed({ hosts: [], sharing: false }))
    expect(result.current).toMatchObject({ sharing: null, sharingOffered: false })
    act(() => changed({ hosts: [], sharing: true }))
    expect(result.current).toMatchObject({ sharing: null, sharingOffered: true })
  })
})

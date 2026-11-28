// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { WslHostAddResult } from '../../../../shared/remote-runtime/wsl-hosts/wsl-host-types'
import { useBotWslSetup } from './use-bot-wsl-setup'

const adds: PromiseWithResolvers<WslHostAddResult>[] = []
vi.mock('@/components/sidebar/host-admission/wsl/add-wsl-host-distro', () => ({
  addWslHostDistro: () => {
    const add = Promise.withResolvers<WslHostAddResult>()
    adds.push(add)
    return add.promise
  }
}))

const distro = (name: string) =>
  ({ name, state: 'stopped', version: 2, environmentId: null }) as const

afterEach(() => {
  adds.length = 0
  vi.unstubAllGlobals()
})

it('ignores an add that finishes after Cancel', async () => {
  vi.stubGlobal('api', {})
  const onAdded = vi.fn()
  const { result } = renderHook(() => useBotWslSetup(onAdded, () => {}))
  act(() => result.current.start(distro('Debian')))
  act(() => result.current.cancel())
  await act(async () => adds[0].resolve({ ok: true, environmentId: 'wsl:debian' }))
  expect(onAdded).not.toHaveBeenCalled()
  expect(result.current.state.phase).toBe('idle')
})

it('picks only the latest distro when an earlier add finishes late', async () => {
  vi.stubGlobal('api', {})
  const onAdded = vi.fn()
  const { result } = renderHook(() => useBotWslSetup(onAdded, () => {}))
  act(() => result.current.start(distro('Debian')))
  act(() => result.current.start(distro('Ubuntu')))
  await act(async () => adds[0].resolve({ ok: true, environmentId: 'wsl:debian' }))
  expect(onAdded).not.toHaveBeenCalled()
  await act(async () => adds[1].resolve({ ok: true, environmentId: 'wsl:ubuntu' }))
  expect(onAdded).toHaveBeenCalledExactlyOnceWith('wsl:ubuntu')
})

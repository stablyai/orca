// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { pluginPanelActDriver, usePluginPanelActDriver } from './plugin-panel-act-driver'

afterEach(cleanup)

function mount(document: string | null = 'doc-1') {
  const sendToGuest = vi.fn()
  const send = vi.fn()
  const hook = renderHook(
    (props: { document: string | null }) =>
      usePluginPanelActDriver({
        tabKey: 'plugin:acme.todos/todos',
        tree: null,
        document: props.document,
        send,
        sendToGuest
      }),
    { initialProps: { document } }
  )
  const driver = pluginPanelActDriver('plugin:acme.todos/todos')
  if (!driver) {
    throw new Error('the panel did not register')
  }
  return { hook, driver, sendToGuest, send }
}

describe('usePluginPanelActDriver', () => {
  it('counts host calls in flight, telling listeners as each starts and settles', () => {
    const { hook, driver } = mount()
    const changes = vi.fn()
    driver.onChange(changes)
    const first = hook.result.current.trackHostCall()
    const second = hook.result.current.trackHostCall()
    expect(driver.pending()).toBe(2)
    first()
    first()
    expect(driver.pending()).toBe(1)
    second()
    expect(driver.pending()).toBe(0)
    expect(changes).toHaveBeenCalledTimes(4)
  })

  it("snapshots and restores the shown guest's atoms, then redraws Orca's controls", () => {
    const { hook, driver, sendToGuest } = mount()
    driver.snapshot()
    expect(sendToGuest).toHaveBeenLastCalledWith('ui.snapshot', { document: 'doc-1' })
    let restored = false
    act(() => {
      restored = driver.restore()
    })
    expect(restored).toBe(true)
    expect(sendToGuest).toHaveBeenLastCalledWith('ui.restore', { document: 'doc-1' })
    expect(hook.result.current.viewEpoch).toBe(1)
    // Once: a second restore has nothing to put back.
    expect(driver.restore()).toBe(false)
  })

  it('does not restore into a guest that reloaded since the snapshot', () => {
    const { hook, driver, sendToGuest } = mount()
    driver.snapshot()
    hook.rerender({ document: 'doc-2' })
    expect(driver.restore()).toBe(false)
    expect(sendToGuest).toHaveBeenCalledTimes(1)
    expect(hook.result.current.viewEpoch).toBe(0)
  })

  it('unregisters when the panel unmounts', () => {
    const { hook } = mount()
    hook.unmount()
    expect(pluginPanelActDriver('plugin:acme.todos/todos')).toBeNull()
  })
})

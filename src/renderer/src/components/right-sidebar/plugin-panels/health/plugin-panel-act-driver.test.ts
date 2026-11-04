// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
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

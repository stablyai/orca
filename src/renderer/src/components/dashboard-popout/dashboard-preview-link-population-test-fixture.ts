import { expect, vi } from 'vitest'
import { waitFor } from '@testing-library/react'
import { Terminal } from '@xterm/xterm'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { openStandaloneTerminal } from '../standalone-terminal/open-standalone-terminal'
import type { DashboardPreviewLinkSource } from './dashboard-preview-http-actions'
import {
  mountPreviewLinkInteraction,
  observePreviewListeners
} from './dashboard-preview-dom-test-fixture'

function observePreviewTimers() {
  type NativeId = ReturnType<typeof window.setTimeout>
  type Callback = Parameters<typeof window.setTimeout>[0]
  type Record = {
    callback: Callback
    callbackId: number
    name: string
    delay: number | undefined
    stack: string | undefined
    id?: NativeId
    executed: number
    canceled: number
  }
  const records: Record[] = []
  const callbackIds = new Map<Callback, number>()
  const clears: Parameters<typeof window.clearTimeout>[0][] = []
  let peakFallbacks = 0
  const ownerOf = (record: Record) => {
    if (
      record.name === 'finishDeferredInput' &&
      record.stack?.includes('terminal-link-pty-mouse-suppression.ts')
    ) {
      return 'adapter-fallback'
    }
    if (
      record.delay === 300000 &&
      record.stack?.includes('/@xterm/xterm/') &&
      record.stack.includes('_resetIdleTimer')
    ) {
      return 'xterm-cursor-idle'
    }
    return 'unattributed'
  }
  const microtasks: { name: string; executed: boolean }[] = []
  const nativeSet = window.setTimeout
  const nativeClear = window.clearTimeout
  const nativeQueue = globalThis.queueMicrotask
  const set = vi.spyOn(window, 'setTimeout').mockImplementation(function (
    this: Window,
    callback,
    delay,
    ...args
  ) {
    let callbackId = callbackIds.get(callback)
    if (callbackId === undefined) {
      callbackId = callbackIds.size + 1
      callbackIds.set(callback, callbackId)
    }
    const record: Record = {
      callback,
      callbackId,
      name: typeof callback === 'function' ? callback.name : 'string',
      delay,
      stack: new Error('Preview timer owner registration').stack,
      executed: 0,
      canceled: 0
    }
    records.push(record)
    const wrapped =
      typeof callback === 'function'
        ? function (this: unknown, ...values: Parameters<Callback>) {
            try {
              return callback.apply(this, values)
            } finally {
              record.executed++
            }
          }
        : callback
    record.id = nativeSet.call(this, wrapped, delay, ...args)
    peakFallbacks = Math.max(
      peakFallbacks,
      records.filter(
        (r) => ownerOf(r) === 'adapter-fallback' && r.canceled === 0 && r.executed === 0
      ).length
    )
    return record.id
  })
  const clear = vi.spyOn(window, 'clearTimeout').mockImplementation(function (this: Window, id) {
    clears.push(id)
    for (const record of records) {
      if (record.id === id) {
        record.canceled++
      }
    }
    return nativeClear.call(this, id)
  })
  const queue = vi.spyOn(globalThis, 'queueMicrotask').mockImplementation(function (
    this: typeof globalThis,
    callback
  ) {
    const record = { name: callback.name, executed: false }
    microtasks.push(record)
    return nativeQueue.call(this, function (this: unknown) {
      try {
        return callback.call(this)
      } finally {
        record.executed = true
      }
    })
  })
  const summary = () => ({
    timers: records.map((record, index) => ({
      id: index + 1,
      callbackId: record.callbackId,
      name: record.name,
      delay: record.delay,
      stack: record.stack,
      owner: ownerOf(record),
      canceled: record.canceled,
      executed: record.executed,
      matchingClearCalls: clears.filter((id) => id === record.id).length
    })),
    microtasks
  })
  return {
    records,
    microtasks,
    ownerOf,
    get peakFallbacks() {
      return peakFallbacks
    },
    summary,
    restore: () => {
      set.mockRestore()
      clear.mockRestore()
      queue.mockRestore()
    }
  }
}

export async function verifyPreviewLinkPopulation(
  population: number,
  source: DashboardPreviewLinkSource,
  readSettings: () => GlobalSettings | null,
  trackInstance: (instance: ReturnType<typeof openStandaloneTerminal>) => void,
  osc: string,
  uri: string,
  pointer: (screen: HTMLElement, type: string, options?: MouseEventInit) => MouseEvent,
  screenFor: (container: HTMLElement) => HTMLElement
) {
  const baseline = Array.from({ length: population }, () =>
    mountPreviewLinkInteraction(source, readSettings, trackInstance, false)
  )
  const defaultFirst = baseline[0]!
  await new Promise<void>((resolve) =>
    defaultFirst.instance.write(osc, { live: true, onDone: resolve })
  )
  const defaultScreen = screenFor(defaultFirst.container)
  pointer(defaultScreen, 'mousemove', { buttons: 0 })
  await waitFor(() =>
    expect(defaultFirst.instance.terminal.element?.getAttribute('title')).toBe(uri)
  )
  const defaults = observePreviewTimers()
  pointer(defaultScreen, 'mousedown')
  pointer(defaultScreen, 'mouseup')
  for (const preview of baseline) {
    preview.instance.dispose()
  }
  await Promise.resolve()
  const defaultSummary = defaults.summary()
  expect(defaults.records.every((record) => defaults.ownerOf(record) === 'xterm-cursor-idle')).toBe(
    true
  )
  expect(defaults.records.every((record) => record.canceled > 0 || record.executed > 0)).toBe(true)
  defaults.restore()
  const provider = vi.spyOn(Terminal.prototype, 'registerLinkProvider')
  const previews = Array.from({ length: population }, () =>
    mountPreviewLinkInteraction(source, readSettings, trackInstance)
  )
  expect(provider).toHaveBeenCalledTimes(population)
  const observation = observePreviewListeners(previews.map((p) => p.instance.terminal.element!))
  const { active } = observation
  const interactions = previews.map((preview) => preview.install())
  expect(provider).toHaveBeenCalledTimes(population)
  expect(active.size).toBe(9 * population)
  document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
  expect(observation.callbacks).toBe(population)
  observation.resetCallbacks()
  const first = previews[0]!
  await new Promise<void>((resolve) => first.instance.write(osc, { live: true, onDone: resolve }))
  const gettersBefore = previews.map((p) => [
    p.getSource.mock.calls.length,
    p.getSettings.mock.calls.length
  ])
  for (let i = 0; i < 10; i++) {
    first.instance.terminal.input('typed')
  }
  expect(first.sink).toHaveBeenCalledTimes(10)
  expect(previews.slice(1).every((p) => p.sink.mock.calls.length === 0)).toBe(true)
  await new Promise<void>((resolve) =>
    first.instance.write(' output', { live: true, onDone: resolve })
  )
  expect(
    previews.map((p) => [p.getSource.mock.calls.length, p.getSettings.mock.calls.length])
  ).toEqual(gettersBefore)
  expect(first.instance.terminal.buffer.active.getLine(0)?.translateToString(true)).toContain(
    'output'
  )
  const screen = screenFor(first.container)
  const timers = observePreviewTimers()
  try {
    pointer(screen, 'mousedown')
    expect(active.size).toBeLessThanOrEqual(9 * population + 16)
    pointer(screen, 'mouseup')
    expect(first.request).toHaveBeenCalledOnce()
    const adapterTimers = timers.records.filter(
      (record) => timers.ownerOf(record) === 'adapter-fallback'
    )
    const nativeTimers = timers.records.filter(
      (record) => timers.ownerOf(record) === 'xterm-cursor-idle'
    )
    expect(timers.records.some((record) => timers.ownerOf(record) === 'unattributed')).toBe(false)
    expect(adapterTimers.length).toBeGreaterThan(0)
    expect(adapterTimers.length).toBeLessThanOrEqual(3)
    expect(timers.peakFallbacks).toBeLessThanOrEqual(1)
    expect(nativeTimers).toHaveLength(defaultSummary.timers.length)
    for (const interaction of interactions) {
      interaction.dispose()
    }
    expect(adapterTimers.every((record) => record.canceled > 0)).toBe(true)
    expect(active.size).toBe(0)
    const reset = previews.map((p) => p.install())
    expect(provider).toHaveBeenCalledTimes(population)
    expect(active.size).toBe(9 * population)
    for (const interaction of reset) {
      interaction.dispose()
    }
    expect(active.size).toBe(0)
    for (const preview of previews) {
      preview.instance.dispose()
    }
    await Promise.resolve()
    expect(nativeTimers.every((record) => record.canceled > 0 || record.executed > 0)).toBe(true)
    const gestureClears = timers.microtasks.filter((task) => task.name === 'clear')
    expect(gestureClears).toHaveLength(population)
    expect(gestureClears.every((task) => task.executed)).toBe(true)
    console.info(
      'TIMER-OWNER-IDENTITIES',
      JSON.stringify({
        population,
        default: defaultSummary,
        adapter: timers.summary(),
        peakFallbacks: timers.peakFallbacks
      })
    )
  } finally {
    for (const interaction of interactions) {
      interaction.dispose()
    }
    for (const preview of previews) {
      preview.instance.dispose()
    }
    timers.restore()
    observation.restore()
  }
}

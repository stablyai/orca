// @vitest-environment happy-dom
import { Profiler, useState } from 'react'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { StateCreator } from 'zustand'
import type * as Zustand from 'zustand'
import type { AppState } from '@/store/types'
import { createBrowserLinkTestStore } from '@/lib/browser-link-open.test-fixture'
import { createStoreCascadesMockApi } from '@/store/slices/store-cascades-test-harness'
import { TooltipProvider } from '@/components/ui/tooltip'
import { LinkActionPopover } from './LinkActionPopover'
import type { LinkActionRequest } from './link-action-request'

type Census = { api: object; live: number; added: number; removed: number; notifications: number }
const registry = vi.hoisted(() => ({ byStateReader: new WeakMap<object, Census>() }))
const fixture = vi.hoisted(
  (): { useStore: ReturnType<typeof createBrowserLinkTestStore> | undefined } => ({
    useStore: undefined
  })
)
vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: AppState) => unknown) => {
      if (!fixture.useStore) {
        throw new Error('Missing real bound fixture store')
      }
      return fixture.useStore(selector)
    },
    { getState: () => fixture.useStore?.getState() }
  )
}))
// Count the inner API before Zustand binds React to it; the bound hook's copied subscribe is too late.
vi.mock('zustand', async (importOriginal) => {
  const actual = await importOriginal<typeof Zustand>()
  function instrument<T>(creator: StateCreator<T, [], []>) {
    return actual.create<T>()((set, get, api) => {
      const census: Census = { api, live: 0, added: 0, removed: 0, notifications: 0 }
      registry.byStateReader.set(api.getState, census)
      const subscribe = api.subscribe
      api.subscribe = (listener) => {
        census.live++
        census.added++
        const off = subscribe((state, previous) => {
          census.notifications++
          listener(state, previous)
        })
        let active = true
        return () => {
          if (active) {
            active = false
            census.live--
            census.removed++
          }
          off()
        }
      }
      return creator(set, get, api)
    })
  }
  return {
    ...actual,
    create: <T,>(creator?: StateCreator<T, [], []>) =>
      creator ? instrument(creator) : instrument<T>
  }
})

const domWindow = window
const api = createStoreCascadesMockApi()
Object.assign(globalThis, { window: domWindow })
Object.assign(window, { api })
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  fixture.useStore = undefined
})

it.each([10, 100])(
  'bounds actual chooser subscriptions and unrelated renders at Q=%s; real action replacement updates consumers and cleanup returns to baseline',
  async (population) => {
    const store = createBrowserLinkTestStore()
    fixture.useStore = store
    const census = registry.byStateReader.get(store.getState)
    if (!census) {
      throw new Error('Missing captured current-store API census')
    }
    const otherStore = createBrowserLinkTestStore()
    const otherCensus = registry.byStateReader.get(otherStore.getState)
    if (!otherCensus) {
      throw new Error('Missing captured other-store API census')
    }
    expect(otherCensus.api).not.toBe(census.api)
    const baseline = census.live
    const initialAdded = census.added
    const initialRemoved = census.removed
    const renders = Array.from({ length: population }, () => 0)
    const request: LinkActionRequest = {
      destination: 'https://example.com/',
      copyValue: 'https://example.com/',
      kind: 'url',
      anchorX: 0,
      anchorY: 0,
      primary: { label: 'System Browser', external: true, run: () => {} },
      restoreFocus: () => {}
    }
    function Choosers({ generation }: { generation: number }) {
      return (
        <TooltipProvider>
          {renders.map((_, index) => (
            <Chooser key={`${generation}:${index}`} index={index} />
          ))}
        </TooltipProvider>
      )
    }
    function Chooser({ index }: { index: number }) {
      const [open, setOpen] = useState(true)
      return open ? (
        <Profiler
          id={String(index)}
          onRender={() => {
            renders[index]++
          }}
        >
          <LinkActionPopover request={request} onClose={() => setOpen(false)} />
        </Profiler>
      ) : null
    }
    const view = render(<Choosers generation={0} />)
    await act(async () => {})
    await waitFor(() =>
      expect(view.getAllByRole('button', { name: 'Terminal link settings' })).toHaveLength(
        population
      )
    )
    expect(census.live - baseline).toBeGreaterThanOrEqual(2 * population)
    expect(census.live - baseline).toBeLessThanOrEqual(4 * population)
    const settled = [...renders]
    const live = census.live
    const ownNotices = census.notifications
    const otherNotices = otherCensus.notifications
    await act(async () => otherStore.setState({ activeView: 'settings' }))
    expect(census.notifications).toBe(ownNotices)
    expect(otherCensus.notifications - otherNotices).toBe(otherCensus.live)
    expect(renders).toEqual(settled)
    for (const host of ['own-host', 'other-host']) {
      const notices = census.notifications
      await act(async () =>
        store.setState((state) => ({
          runtimeStatusByEnvironmentId: new Map(state.runtimeStatusByEnvironmentId).set(host, {
            status: null,
            checkedAt: 1
          })
        }))
      )
      expect(renders).toEqual(settled)
      expect(census.notifications - notices).toBe(live)
    }
    const original = store.getState().openSettingsPage
    const replacement = vi.fn(() => original())
    const notices = census.notifications
    await act(async () => store.setState({ openSettingsPage: replacement }))
    expect(renders.every((count, index) => count > settled[index]!)).toBe(true)
    expect(census.notifications - notices).toBe(live)
    fireEvent.click(view.getAllByRole('button', { name: 'Terminal link settings' })[0]!)
    expect(replacement).toHaveBeenCalledOnce()
    expect(store.getState().activeView).toBe('settings')
    expect(census.live - baseline).toBeGreaterThanOrEqual(2 * (population - 1))
    expect(census.live).toBeLessThan(live)
    for (const button of view.getAllByRole('button', { name: /System Browser/ })) {
      fireEvent.click(button)
    }
    expect(census.live).toBe(baseline)
    view.unmount()
    expect(census.live).toBe(baseline)
    const remount = render(<Choosers generation={1} />)
    await act(async () => {})
    expect(census.live - baseline).toBeGreaterThanOrEqual(2 * population)
    expect(census.live - baseline).toBeLessThanOrEqual(4 * population)
    remount.unmount()
    expect(census.live).toBe(baseline)
    expect(census.added - initialAdded).toBeLessThanOrEqual(8 * population)
    expect(census.added - initialAdded).toBe(census.removed - initialRemoved)
    store.setState({ openSettingsPage: original })
  }
)

// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { toast as sonnerToast } from 'sonner'
import type { Toaster as OrcaToaster } from './sonner'
import type { GeneratedAgentInputNotice } from '../../../../shared/generated-agent-input-notice'
import { generatedInputNoticeFrames } from '../../../../shared/generated-agent-input-notice'

const fixture = vi.hoisted(() => ({ modalRenders: 0 }))
vi.mock('@/store', () => ({
  useAppStore: (select: (state: unknown) => unknown) => select({ settings: { theme: 'dark' } })
}))
vi.mock('@/lib/telemetry', () => ({ track: vi.fn() }))
vi.mock('@/lib/notification-card-layout-vars', () => ({
  useNotificationCardLayoutVarReader: () => {}
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: vi.fn(async () => ({})) }))

let root: Root | undefined
let container: HTMLDivElement
let toast: typeof sonnerToast
let Toaster: typeof OrcaToaster
let changedHeight = false
const rendered = new Map<string | number, number>()
let measurements = 0
let identityReads = 0
let storeLookups = 0
let showStar: ((payload: { surface: 'toast'; mode: 'gh' }) => void) | undefined
let iteration = 0
const clipboard = vi.fn(async () => {})
const dismissStar = vi.fn(async () => {})

async function settle(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
}

beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  fixture.modalRenders = 0
  changedHeight = false
  measurements = 0
  identityReads = 0
  storeLookups = 0
  rendered.clear()
  clipboard.mockClear()
  dismissStar.mockClear()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    setTimeout(() => callback(0), 0)
  )
  vi.stubGlobal('cancelAnimationFrame', clearTimeout)
  Object.assign(window, {
    api: {
      ui: { writeClipboardText: clipboard },
      starNag: {
        onShow: (callback: typeof showStar) => {
          showStar = callback
          return () => {}
        },
        onHide: () => () => {},
        dismiss: dismissStar,
        later: vi.fn(async () => {}),
        openWeb: vi.fn(async () => {}),
        starOrca: vi.fn(async () => true)
      },
      shell: { openUrl: vi.fn(async () => {}) }
    }
  })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
    measurements++
    return DOMRect.fromRect({
      width: 340,
      height: changedHeight && this.textContent?.includes('Codex') ? 60 : 40
    })
  })
  const get = Map.prototype.get
  vi.spyOn(Map.prototype, 'get').mockImplementation(function (key) {
    if (key === 'measure:live') {
      storeLookups++
    }
    if (typeof key === 'string' && key.startsWith('generated-input:')) {
      identityReads++
    }
    return get.call(this, key)
  })
  // Count actual private row renders while still executing its original hooks and JSX.
  const createElement = React.createElement
  const wrappers = new WeakMap<object, React.ElementType>()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the wrapper forwards every argument to the original createElement.
  vi.spyOn(React, 'createElement').mockImplementation(((
    type: React.ElementType,
    props: Record<string, unknown>,
    ...children: React.ReactNode[]
  ) => {
    if (typeof type === 'function' && type.name === 'Toast') {
      let wrapped = wrappers.get(type)
      if (!wrapped) {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: guarded above: sonner's Toast is a function component taking a toast prop.
        const original = type as React.FunctionComponent<{ toast: { id: string | number } }>
        wrapped = function CountedToast(p: { toast: { id: string | number } }) {
          rendered.set(p.toast.id, (rendered.get(p.toast.id) ?? 0) + 1)
          return original(p)
        }
        wrappers.set(type, wrapped)
      }
      return createElement(wrapped, props, ...children)
    }
    return createElement(type, props, ...children)
  }) as typeof React.createElement)
  ;({ toast } = await import('sonner'))
  toast.dismiss()
  iteration++
  ;({ Toaster } = await import('./sonner'))
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  container.remove()
  document.body.removeAttribute('data-modal-overlay-open')
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function mount(
  children?: React.ReactNode,
  props: React.ComponentProps<typeof OrcaToaster> = {}
): void {
  root = createRoot(container)
  act(() =>
    root!.render(
      <>
        <Toaster {...props} />
        {children}
      </>
    )
  )
}

function notice(id: string): GeneratedAgentInputNotice {
  return {
    id,
    agent: 'claude',
    text: `exact ${id}`,
    certainty: 'not-sent',
    handle: 'h',
    worktreeId: 'w',
    ptyId: null
  }
}

it.each([100, 1_000])('keeps one-ID store work independent of %i historical records', (history) => {
  const prefix = `history:${iteration}:`
  toast.batch(() => {
    for (let index = 0; index < history; index++) {
      toast.message('old', { id: `${prefix}${index}`, duration: Infinity })
    }
    toast.dismiss()
    toast.message('live', { id: 'measure:live', duration: Infinity })
  })
  expect(toast.getHistory().filter((record) => String(record.id).startsWith(prefix))).toHaveLength(
    history
  )
  expect(toast.getToasts()).toHaveLength(1)
  storeLookups = 0
  let traversed = 0
  const values = Map.prototype.values
  const valuesSpy = vi.spyOn(Map.prototype, 'values').mockImplementation(function () {
    const iterator = values.call(this)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: it forwards to the real iterator's next and is its own iterator.
    return {
      ...iterator,
      next: () => {
        const value = iterator.next()
        if (!value.done && value.value?.id?.startsWith?.('history:')) {
          traversed++
        }
        return value
      },
      [Symbol.iterator]() {
        return this
      }
    } as MapIterator<unknown>
  })
  toast.message('changed', { id: 'measure:live' })
  expect(storeLookups).toBeLessThanOrEqual(8)
  expect(traversed).toBe(0)
  valuesSpy.mockRestore()
})

it.each([100, 1_000])(
  'publishes a %i-record production snapshot once and isolates unchanged-height row updates',
  async (n) => {
    const { createGeneratedInputNoticeFeed } =
      await import('../../../../shared/generated-input-notice-feed')
    const { projectGeneratedInputNotices } =
      await import('@/runtime/generated-input-notice-toast-projection')
    const { useSonnerIds } = await import('sonner')
    function MembershipProbe() {
      useSonnerIds()
      fixture.modalRenders++
      return null
    }
    mount(<MembershipProbe />)
    const records = Array.from({ length: n }, (_, index) => notice(`row:${index}`))
    const projection = projectGeneratedInputNotices({ kind: 'local' })
    let complete!: () => void
    const completed = new Promise<void>((resolve) => {
      complete = resolve
    })
    const feed = createGeneratedInputNoticeFeed({
      ...projection,
      onSnapshot: (...args) => {
        projection.onSnapshot(...args)
        complete()
      },
      readPage: async (from) => {
        const start = from?.cursor ?? 0
        return {
          session: 'source',
          revision: n,
          frames: records
            .slice(start, start + 100)
            .flatMap((record) => generatedInputNoticeFrames(record).frames),
          next: start + 100 < n ? { cursor: start + 100, offset: 0 } : null
        }
      }
    })
    const membership = fixture.modalRenders
    await act(async () => {
      feed.receive({ type: 'ready', session: 'source', revision: n })
      await completed
    })
    await settle()
    expect(container.querySelectorAll('[data-sonner-toast]')).toHaveLength(n)
    expect(fixture.modalRenders - membership).toBe(1)
    expect(measurements).toBeLessThanOrEqual(n * 4)
    // Each row needs a bounded number of store, layout and subscription lookups.
    expect(identityReads).toBeLessThanOrEqual(n * 100)
    const original = toast.getToasts().find((record) => record.id === 'generated-input:row:0')!
    expect(original).toBeDefined()
    rendered.clear()
    measurements = 0
    fixture.modalRenders = 0
    identityReads = 0
    const updated = { ...records[0], certainty: 'unconfirmed' as const }
    await act(async () => {
      for (const frame of generatedInputNoticeFrames(updated).frames) {
        feed.receive({ type: 'notice', session: 'source', revision: n + 1, frame })
      }
    })
    expect([...rendered.keys()]).toEqual(['generated-input:row:0'])
    expect(rendered.get('generated-input:row:0')).toBe(1)
    expect(measurements).toBeLessThanOrEqual(1)
    expect(fixture.modalRenders).toBe(0)
    expect(identityReads).toBeLessThanOrEqual(100)
    rendered.clear()
    measurements = 0
    identityReads = 0
    await act(async () => {
      for (const frame of generatedInputNoticeFrames(updated).frames) {
        feed.receive({ type: 'notice', session: 'source', revision: n + 1, frame })
      }
    })
    expect(rendered.size).toBe(0)
    expect(measurements).toBe(0)
    expect(identityReads).toBe(0)
    changedHeight = true
    await act(async () => {
      for (const frame of generatedInputNoticeFrames({ ...updated, agent: 'codex' }).frames) {
        feed.receive({ type: 'notice', session: 'source', revision: n + 2, frame })
      }
    })
    // The oldest row changes height; no successor geometry or unrelated row changes.
    expect([...rendered.keys()]).toEqual(['generated-input:row:0'])
    expect(measurements).toBeLessThanOrEqual(1)
    expect(fixture.modalRenders).toBe(0)
    expect(identityReads).toBeLessThanOrEqual(100)
    const oldest = [...container.querySelectorAll<HTMLElement>('[data-sonner-toast]')].at(-1)!
    expect(oldest.style.getPropertyValue('--initial-height')).toBe('60px')
    const previousOffset = Number.parseFloat(oldest.style.getPropertyValue('--offset'))
    rendered.clear()
    measurements = 0
    identityReads = 0
    const middle = Math.floor(n / 2)
    await act(async () => {
      for (const frame of generatedInputNoticeFrames({ ...records[middle], agent: 'codex' })
        .frames) {
        feed.receive({ type: 'notice', session: 'source', revision: n + 3, frame })
      }
    })
    // Only the changed middle row and its older successors have new output.
    expect(new Set(rendered.keys())).toEqual(
      new Set(Array.from({ length: middle + 1 }, (_, index) => `generated-input:row:${index}`))
    )
    expect(Number.parseFloat(oldest.style.getPropertyValue('--offset'))).toBe(previousOffset + 20)
    expect(fixture.modalRenders).toBe(0)
    expect(measurements).toBeLessThanOrEqual(1)
    expect(identityReads).toBeLessThanOrEqual((middle + 1) * 20 + 100)
    rendered.clear()
    measurements = 0
    identityReads = 0
    await act(async () => {
      toast.dismiss(`generated-input:row:${n - 1}`)
      await vi.advanceTimersByTimeAsync(501)
    })
    // Removing the front changes each remaining rank/offset once, with no prefix scans.
    expect(container.querySelectorAll('[data-sonner-toast]')).toHaveLength(n - 1)
    expect(identityReads).toBeLessThanOrEqual(n * 100)
    expect(measurements).toBeLessThanOrEqual(n * 2)
    expect(Math.max(...rendered.values())).toBeLessThanOrEqual(6)
    identityReads = 0
    await act(async () => {
      toast.dismiss()
      await vi.advanceTimersByTimeAsync(501)
    })
    expect(container.querySelectorAll('[data-sonner-toast]')).toHaveLength(0)
    expect(identityReads).toBeLessThanOrEqual(n * 100)
    feed.stop()
  }
)

it('keeps common ordering, Copy, finite timers, promises, custom content and dismissal callbacks', async () => {
  const { showGeneratedInputNotice } = await import('@/lib/generated-input-notice-toast')
  const { StarNagToastHost } = await import('../star-nag/StarNagToastHost')
  mount(<StarNagToastHost />)
  const closed = vi.fn()
  act(() => {
    toast.message('ordinary', {
      id: 'ordinary',
      duration: 1_000,
      closeButton: true,
      onAutoClose: closed
    })
    showGeneratedInputNotice({ id: 'generated', text: 'exact\nclipboard', agent: 'claude' })
  })
  await settle()
  const copy = [...container.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('Copy prompt')
  )!
  expect(copy).toBeDefined()
  act(() => copy.click())
  expect(clipboard).toHaveBeenCalledExactlyOnceWith('exact\nclipboard')
  expect(toast.getToasts().some((record) => record.id === 'generated')).toBe(true)
  act(() => toast.message('ordinary updated', { id: 'ordinary', duration: 1_000 }))
  await settle()
  const titles = [...container.querySelectorAll('[data-title]')].map((node) => node.textContent)
  expect(titles[0]).toContain("wasn't sent")
  expect(titles[1]).toBe('ordinary updated')
  await act(async () => vi.advanceTimersByTimeAsync(1_501))
  expect(closed).toHaveBeenCalledOnce()
  expect(toast.getToasts().some((record) => record.id === 'generated')).toBe(true)
  let resolve!: (value: string) => void
  act(() => {
    toast.promise(
      new Promise<string>((done) => {
        resolve = done
      }),
      { id: 'promise', loading: 'pending', success: (value) => value }
    )
  })
  await act(async () => resolve('finished'))
  await settle()
  expect(container.textContent).toContain('finished')
  act(() => showStar?.({ surface: 'toast', mode: 'gh' }))
  await settle()
  expect(container.textContent).toContain('Star on GitHub')
  const later = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'Later'
  )!
  act(() => later.click())
  await settle()
  expect(dismissStar).not.toHaveBeenCalled()
  const dismissed = vi.fn()
  act(() => toast.message('close me', { id: 'close', duration: Infinity, onDismiss: dismissed }))
  act(() => toast.dismiss('close'))
  await act(async () => vi.advanceTimersByTimeAsync(501))
  expect(dismissed).toHaveBeenCalledOnce()
  act(() => toast.message('revived', { id: 'close', duration: Infinity }))
  await settle()
  expect(container.textContent).toContain('revived')
  expect(toast.getToasts().filter((record) => record.id === 'close')).toHaveLength(1)
  act(() => toast.dismiss('close'))
  act(() => toast.message('revived before exit', { id: 'close', duration: Infinity }))
  await act(async () => vi.advanceTimersByTimeAsync(501))
  expect(container.textContent).toContain('revived before exit')
  expect(container.querySelector('[data-removed="true"] [data-title]')?.textContent).not.toBe(
    'revived before exit'
  )
})

function row(testId: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(`[data-testid="${testId}"]`)
  expect(element).not.toBeNull()
  return element!
}

function offset(testId: string): string {
  return row(testId).style.getPropertyValue('--offset')
}

it.each([100, 1_000])('releases a whole %i-row layout without obsolete suffix work', async (n) => {
  act(() => {
    toast.batch(() => {
      for (let index = 0; index < n; index++) {
        toast.message('live', { id: `generated-input:unmount:${index}`, duration: Infinity })
      }
    })
  })
  mount()
  await settle()
  expect(container.querySelectorAll('[data-sonner-toast]')).toHaveLength(n)
  rendered.clear()
  measurements = 0
  identityReads = 0
  act(() => root!.unmount())
  root = undefined
  expect(container.childElementCount).toBe(0)
  expect(rendered.size).toBe(0)
  expect(measurements).toBe(0)
  expect(identityReads).toBeLessThanOrEqual(n * 20)
  expect(toast.getToasts()).toHaveLength(n)
})

it('remeasures a settled identical-content revival and updates its live successors', async () => {
  mount(undefined, { gap: 8 })
  act(() => {
    toast.batch(() => {
      for (const id of ['C', 'B', 'A']) {
        toast.message(id, { id: `generated-input:revival:${id}`, testId: id, duration: Infinity })
      }
    })
  })
  await settle()
  expect(offset('C')).toBe('96px')
  act(() => toast.dismiss('generated-input:revival:A'))
  await settle()
  await act(async () => vi.advanceTimersByTimeAsync(50))
  expect(offset('C')).toBe('48px')
  act(() =>
    toast.message('A', { id: 'generated-input:revival:A', testId: 'A', duration: Infinity })
  )
  await settle()
  expect(offset('C')).toBe('96px')
  changedHeight = true
  act(() => toast.message('Codex B', { id: 'generated-input:revival:B' }))
  await settle()
  expect(row('B').style.getPropertyValue('--initial-height')).toBe('60px')
  expect(offset('C')).toBe('116px')
  await act(async () => vi.advanceTimersByTimeAsync(201))
  expect(container.querySelectorAll('[data-sonner-toast]')).toHaveLength(3)
  expect(row('A').dataset.removed).toBe('false')
})

it('ignores an old exit timer before it can consume a newer bulk exit cohort', async () => {
  const dismissed = vi.fn()
  mount()
  act(() => {
    toast.batch(() => {
      for (const id of ['B', 'A']) {
        toast.message(id, {
          id: `generated-input:cohort:${id}`,
          duration: Infinity,
          onDismiss: dismissed
        })
      }
    })
  })
  await settle()
  act(() => toast.dismiss('generated-input:cohort:A'))
  await settle()
  await act(async () => vi.advanceTimersByTimeAsync(50))
  act(() => toast.message('revived A', { id: 'generated-input:cohort:A', duration: Infinity }))
  await settle()
  await act(async () => vi.advanceTimersByTimeAsync(50))
  act(() => toast.dismiss())
  await settle()
  await act(async () => vi.advanceTimersByTimeAsync(100))
  expect(container.querySelectorAll('[data-sonner-toast]')).toHaveLength(2)
  await act(async () => vi.advanceTimersByTimeAsync(101))
  expect(container.querySelectorAll('[data-sonner-toast]')).toHaveLength(0)
  expect(toast.getToasts()).toHaveLength(0)
  expect(dismissed).toHaveBeenCalledTimes(3)
})

it('keeps departing offsets while live successors close the gap', async () => {
  mount(undefined, { gap: 8 })
  act(() => {
    toast.batch(() => {
      for (const id of ['C', 'B', 'A']) {
        toast.message(id, { id: `generated-input:offset:${id}`, testId: id, duration: Infinity })
      }
    })
  })
  await settle()
  expect(['A', 'B', 'C'].map(offset)).toEqual(['0px', '48px', '96px'])
  act(() => toast.dismiss('generated-input:offset:B'))
  await settle()
  expect(['A', 'B', 'C'].map(offset)).toEqual(['0px', '48px', '48px'])
  act(() => toast.dismiss())
  await settle()
  expect(['A', 'B', 'C'].map(offset)).toEqual(['0px', '48px', '48px'])
  await act(async () => vi.advanceTimersByTimeAsync(201))
  expect(container.querySelectorAll('[data-sonner-toast]')).toHaveLength(0)
})

it('reconnects common measurements after StrictMode owner cleanup', async () => {
  act(() => {
    toast.batch(() => {
      for (const id of ['B', 'A']) {
        toast.message(id, { id: `generated-input:strict:${id}`, testId: id, duration: Infinity })
      }
    })
  })
  root = createRoot(container)
  act(() =>
    root!.render(
      <React.StrictMode>
        <Toaster gap={8} />
      </React.StrictMode>
    )
  )
  await settle()
  expect(offset('B')).toBe('48px')
  changedHeight = true
  act(() => toast.message('Codex A', { id: 'generated-input:strict:A' }))
  await settle()
  expect(offset('B')).toBe('68px')
  expect(row('A').style.getPropertyValue('--initial-height')).toBe('60px')
})

it('preserves synchronous exception-safe batch reads and the CommonJS entry contract', () => {
  let returned: string | number | undefined
  expect(() =>
    toast.batch(() => {
      returned = toast.message('first', { id: 'batch' })
      expect(toast.getToasts().map((record) => record.id)).toEqual(['batch'])
      toast.message('last', { id: 'batch' })
      throw new Error('callback failure')
    })
  ).toThrow('callback failure')
  expect(returned).toBe('batch')
  expect(toast.getToasts()).toMatchObject([{ id: 'batch', title: 'last' }])
  const result = execFileSync(
    process.execPath,
    [
      '-e',
      `const {toast}=require('sonner');let id;try{toast.batch(()=>{id=toast.message('first',{id:'batch'});toast.message('last',{id:'batch'});throw Error('expected')})}catch{};process.stdout.write(JSON.stringify({id,rows:toast.getToasts().map(t=>({id:t.id,title:t.title}))}))`
    ],
    { encoding: 'utf8' }
  )
  expect(JSON.parse(result)).toEqual({ id: 'batch', rows: [{ id: 'batch', title: 'last' }] })
})

it('keeps the common modal gate, new-notice raising, focus hotkey, Escape and swipe dismissal', async () => {
  const action = vi.fn((event: React.MouseEvent) => event.preventDefault())
  const dismissed = vi.fn()
  mount()
  act(() =>
    toast.message('before modal', {
      id: 'before-modal',
      duration: Infinity,
      closeButton: true,
      action: { label: 'Old action', onClick: action }
    })
  )
  await settle()
  const overlay = document.createElement('div')
  overlay.dataset.slot = 'dialog-overlay'
  overlay.style.zIndex = '50'
  await act(async () => {
    document.body.appendChild(overlay)
    document.body.setAttribute('data-modal-overlay-open', '')
    await Promise.resolve()
  })
  const old = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'Old action'
  )!
  act(() => old.click())
  expect(action).not.toHaveBeenCalled()
  act(() =>
    toast.message('after modal', {
      id: 'after-modal',
      duration: Infinity,
      action: { label: 'New action', onClick: action }
    })
  )
  await settle()
  expect(container.querySelector('[data-toasts-raised]')).not.toBeNull()
  act(() =>
    [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'New action')!
      .click()
  )
  expect(action).toHaveBeenCalledOnce()
  expect(toast.getToasts().some((record) => record.id === 'after-modal')).toBe(true)
  expect(container.querySelector('[aria-live="polite"]')).not.toBeNull()
  act(() =>
    document.dispatchEvent(
      new KeyboardEvent('keydown', { code: 'KeyT', altKey: true, bubbles: true })
    )
  )
  expect(document.activeElement).toBe(container.querySelector('[data-sonner-toaster]'))
  expect(container.querySelector('[data-sonner-toast]')?.getAttribute('data-expanded')).toBe('true')
  act(() => document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', bubbles: true })))
  expect(container.querySelector('[data-sonner-toast]')?.getAttribute('data-expanded')).toBe(
    'false'
  )
  act(() => {
    document.body.removeAttribute('data-modal-overlay-open')
    overlay.remove()
    toast.message('swipe', {
      id: 'swipe',
      testId: 'swipe',
      duration: Infinity,
      onDismiss: dismissed
    })
  })
  await settle()
  const row = container.querySelector<HTMLElement>('[data-testid="swipe"]')!
  row.setPointerCapture = vi.fn()
  act(() =>
    row.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, clientX: 0, clientY: 0 })
    )
  )
  act(() =>
    row.dispatchEvent(
      new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientX: 50, clientY: 0 })
    )
  )
  act(() =>
    row.dispatchEvent(
      new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientX: 100, clientY: 0 })
    )
  )
  act(() =>
    row.dispatchEvent(
      new PointerEvent('pointerup', { bubbles: true, pointerId: 1, clientX: 100, clientY: 0 })
    )
  )
  await act(async () => vi.advanceTimersByTimeAsync(501))
  expect(dismissed).toHaveBeenCalledOnce()
  expect(toast.getToasts().some((record) => record.id === 'swipe')).toBe(false)
})

// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import {
  StrictMode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps
} from 'react'
import { createPortal, flushSync } from 'react-dom'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import * as Layer from '@radix-ui/react-dismissable-layer'
import * as Menu from '@radix-ui/react-menu'
import * as Dropdown from 'radix-ui/dropdown-menu'
import { afterEach, expect, it, vi } from 'vitest'
import { pointer, mountLayer } from './dismissable-layer-pointer.test-fixture'

const require = createRequire(import.meta.url)
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it.each(['mouse', 'touch'])(
  'does not carry pre-registration %s interior truth into the first outside',
  (kind) => {
    vi.useFakeTimers()
    const { node, dismiss, outside } = mountLayer()
    pointer(node, kind)
    act(() => vi.runOnlyPendingTimers())
    const original = pointer(document.body, kind)
    expect(outside).toHaveBeenCalledOnce()
    expect(outside.mock.calls[0][0].detail.originalEvent).toBe(original)
    expect(dismiss).toHaveBeenCalledOnce()
  }
)

it.each(['mouse', 'pen'])(
  'enrolls before the first fresh %s outside, without flushing registration timers',
  (kind) => {
    vi.useFakeTimers()
    const { dismiss, outside } = mountLayer()
    const original = pointer(document.body, kind)
    expect(outside).toHaveBeenCalledOnce()
    expect(outside.mock.calls[0][0].detail.originalEvent).toBe(original)
    expect(dismiss).toHaveBeenCalledOnce()
  }
)

it('retains logical portal inside after stopped bubble, but not authority over a distinct outside', () => {
  const dismiss = vi.fn()
  render(
    <Layer.Root onDismiss={dismiss}>
      {createPortal(
        <button onPointerDown={(event) => event.stopPropagation()}>Logical child</button>,
        document.body
      )}
    </Layer.Root>
  )
  const retainedMissed = pointer(screen.getByText('Logical child'))
  expect(dismiss).not.toHaveBeenCalled()
  pointer(document.body)
  expect(dismiss).toHaveBeenCalledOnce()
  expect(retainedMissed.target).toBe(screen.getByText('Logical child'))
})

it('keeps outer logical-inside membership during distinct nested dispatch and consumes handled redispatch', () => {
  const dismiss = vi.fn()
  const outside = vi.fn()
  render(
    <Layer.Root onDismiss={dismiss} onPointerDownOutside={outside}>
      <button onPointerDown={() => pointer(document.body)}>Inside</button>
    </Layer.Root>
  )
  const handled = pointer(screen.getByText('Inside'))
  expect(outside).toHaveBeenCalledOnce()
  expect(outside.mock.calls[0][0].detail.originalEvent.target).toBe(document.body)
  expect(dismiss).toHaveBeenCalledOnce()
  // This object completed handling; reusing it is distinct from replaying a missed inside object.
  fireEvent(document.body, handled)
  expect(outside).toHaveBeenCalledTimes(2)
  expect(dismiss).toHaveBeenCalledTimes(2)
})

it('consumes both memberships before a consumer synchronously reenters with a fresh outside', () => {
  let nested = false
  const dismiss = vi.fn()
  const outside = vi.fn(() => {
    if (!nested) {
      nested = true
      pointer(document.body, 'pen')
    }
  })
  mountLayer({ onDismiss: dismiss, onPointerDownOutside: outside })
  pointer(document.body)
  expect(outside).toHaveBeenCalledTimes(2)
  expect(dismiss).toHaveBeenCalledTimes(2)
})

it('uses committed branches and highest modal membership before timers, without changing body policy', () => {
  vi.useFakeTimers()
  const low = vi.fn()
  const high = vi.fn()
  const originalBody = document.body.style.pointerEvents
  const view = render(
    <>
      <Layer.Root onDismiss={low}>Lower</Layer.Root>
      <Layer.Branch>
        <button>Branch</button>
      </Layer.Branch>
      <Layer.Root disableOutsidePointerEvents onDismiss={high}>
        Modal
      </Layer.Root>
    </>
  )
  expect(document.body.style.pointerEvents).toBe('none')
  pointer(screen.getByText('Branch'))
  expect(low).not.toHaveBeenCalled()
  expect(high).not.toHaveBeenCalled()
  pointer(document.body)
  expect(low).not.toHaveBeenCalled()
  expect(high).toHaveBeenCalledOnce()
  view.unmount()
  expect(document.body.style.pointerEvents).toBe(originalBody)
})

it('preserves the lower retained sibling refusal when a later-created modal closes first', () => {
  vi.useFakeTimers()
  const menuRequire = createRequire(require.resolve('@radix-ui/react-menu'))
  expect(menuRequire.resolve('@radix-ui/react-dismissable-layer')).toBe(
    require.resolve('@radix-ui/react-dismissable-layer')
  )
  const lowChanged = vi.fn()
  const highChanged = vi.fn()
  const lowOutside = vi.fn()
  const highOutside = vi.fn()
  const physicalNodes: HTMLDivElement[] = []
  const rememberNode = (node: HTMLDivElement | null) => {
    if (node && !physicalNodes.includes(node)) {
      physicalNodes.push(node)
    }
  }
  const preventAutoFocus: NonNullable<ComponentProps<typeof Menu.Content>['onOpenAutoFocus']> = (
    event
  ) => event.preventDefault()
  function Siblings({ showHigh }: { showHigh: boolean }) {
    const [lowOpen, setLowOpen] = useState(false)
    const [highOpen, setHighOpen] = useState(true)
    return (
      <>
        <button onClick={() => setLowOpen(true)}>Activate lower</button>
        <Menu.Root
          modal={false}
          open={lowOpen}
          onOpenChange={(open) => {
            lowChanged(open)
            setLowOpen(open)
          }}
        >
          <Menu.Portal forceMount>
            <Menu.Content
              forceMount
              ref={rememberNode}
              data-testid="lower-retained"
              onOpenAutoFocus={preventAutoFocus}
              onCloseAutoFocus={preventAutoFocus}
              onPointerDownOutside={lowOutside}
            >
              Lower
            </Menu.Content>
          </Menu.Portal>
        </Menu.Root>
        {showHigh && (
          <Menu.Root
            modal
            open={highOpen}
            onOpenChange={(open) => {
              highChanged(open)
              setHighOpen(open)
            }}
          >
            <Menu.Portal forceMount>
              <Menu.Content
                forceMount
                ref={rememberNode}
                data-testid="higher-retained"
                onOpenAutoFocus={preventAutoFocus}
                onCloseAutoFocus={preventAutoFocus}
                onPointerDownOutside={highOutside}
              >
                Higher
              </Menu.Content>
            </Menu.Portal>
          </Menu.Root>
        )}
      </>
    )
  }
  const originalBody = document.body.style.pointerEvents
  const view = render(<Siblings showHigh={false} />)
  const low = screen.getByTestId('lower-retained')
  expect(low).toHaveAttribute('data-state', 'closed')
  expect(physicalNodes).toEqual([low])
  act(() => vi.runOnlyPendingTimers())
  view.rerender(<Siblings showHigh />)
  const high = screen.getByTestId('higher-retained')
  act(() => vi.runOnlyPendingTimers())
  fireEvent.click(screen.getByText('Activate lower'))
  act(() => vi.runOnlyPendingTimers())
  expect(physicalNodes).toEqual([low, high])
  expect(screen.getByTestId('lower-retained')).toBe(low)
  expect(screen.getByTestId('higher-retained')).toBe(high)
  expect(low).toHaveAttribute('data-state', 'open')
  expect(high).toHaveAttribute('data-state', 'open')
  expect(low.style.pointerEvents).toBe('none')
  expect(document.body.style.pointerEvents).toBe('none')
  expect(lowChanged).not.toHaveBeenCalled()
  expect(highChanged).not.toHaveBeenCalled()
  const original = pointer(document.documentElement)
  expect(highOutside).toHaveBeenCalledOnce()
  expect(highOutside.mock.calls[0][0].detail.originalEvent).toBe(original)
  expect(highChanged).toHaveBeenCalledExactlyOnceWith(false)
  expect(high).toHaveAttribute('data-state', 'closed')
  expect(screen.getByTestId('higher-retained')).toBe(high)
  expect(lowOutside).not.toHaveBeenCalled()
  expect(lowChanged).not.toHaveBeenCalled()
  expect(low).toHaveAttribute('data-state', 'open')
  expect(document.body.style.pointerEvents).toBe(originalBody)
})

it('enrolls an existing node and refreshes callbacks before the parent layout probe and passive refresh', () => {
  vi.useFakeTimers()
  const stale = vi.fn()
  const current = vi.fn()
  const dismiss = vi.fn()
  const phases: { passiveActive: boolean; connected: boolean }[] = []
  const original = new PointerEvent('pointerdown', {
    bubbles: true,
    cancelable: true,
    pointerType: 'mouse',
    button: 0
  })
  function Probe({ active }: { active: boolean }) {
    const passiveActive = useRef(false)
    const node = useRef<HTMLDivElement>(null)
    useLayoutEffect(() => {
      if (!active) {
        return
      }
      phases.push({
        passiveActive: passiveActive.current,
        connected: node.current?.isConnected === true
      })
      // The child has completed layout work; native browser input cannot interrupt this commit.
      document.documentElement.dispatchEvent(original)
    }, [active])
    useEffect(() => {
      passiveActive.current = active
    }, [active])
    return (
      <Layer.Root
        ref={node}
        pointerDownOutsideEnabled={active}
        onPointerDownOutside={active ? current : stale}
        onDismiss={dismiss}
      />
    )
  }
  const view = render(<Probe active={false} />)
  act(() => vi.runOnlyPendingTimers())
  expect(dismiss).not.toHaveBeenCalled()
  view.rerender(<Probe active />)
  expect(phases).toEqual([{ passiveActive: false, connected: true }])
  expect(stale).not.toHaveBeenCalled()
  expect(current).toHaveBeenCalledOnce()
  expect(current.mock.calls[0][0].detail.originalEvent).toBe(original)
  expect(dismiss).toHaveBeenCalledOnce()
})

it('preserves cancelable pointer/interact refusal and admits the next independent event', () => {
  const interact = vi.fn()
  const dismiss = vi.fn()
  const view = mountLayer({
    onDismiss: dismiss,
    onPointerDownOutside: (event) => event.preventDefault(),
    onInteractOutside: interact
  })
  pointer(document.body)
  expect(interact).toHaveBeenCalledOnce()
  expect(interact.mock.calls[0][0].defaultPrevented).toBe(true)
  expect(dismiss).not.toHaveBeenCalled()
  view.rerender(<Layer.Root onDismiss={dismiss} onInteractOutside={interact} />)
  pointer(document.body)
  expect(interact).toHaveBeenCalledTimes(2)
  expect(dismiss).toHaveBeenCalledOnce()
})

function Surface() {
  const ref = Layer.useDismissableLayerSurface()
  return (
    <div
      ref={ref}
      data-testid="surface"
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    />
  )
}
it('retains deferred complete-click, nonprimary immediate, intercepted cancellation and surface admission', () => {
  vi.useFakeTimers()
  const { dismiss } = mountLayer({ deferPointerDownOutside: true })
  const target = document.createElement('div')
  document.body.append(target)
  pointer(target)
  expect(dismiss).not.toHaveBeenCalled()
  fireEvent.mouseDown(target)
  fireEvent.mouseUp(target)
  fireEvent.click(target)
  expect(dismiss).toHaveBeenCalledOnce()
  pointer(target, 'mouse', 2)
  expect(dismiss).toHaveBeenCalledTimes(2)
  const stop = (event: Event) => event.stopPropagation()
  target.addEventListener('mousedown', stop)
  pointer(target)
  fireEvent.mouseDown(target)
  fireEvent.mouseUp(target)
  fireEvent.click(target)
  act(() => vi.runOnlyPendingTimers())
  expect(dismiss).toHaveBeenCalledTimes(2)
  const surface = render(<Surface />)
  const overlay = surface.getByTestId('surface')
  pointer(overlay)
  fireEvent.mouseDown(overlay)
  fireEvent.click(overlay)
  act(() => vi.runOnlyPendingTimers())
  expect(dismiss).toHaveBeenCalledTimes(3)
  target.remove()
})

it('refreshes committed callbacks without erasing a live event membership mid-dispatch', () => {
  const stale = vi.fn()
  const current = vi.fn()
  const view = mountLayer({ deferPointerDownOutside: true, onPointerDownOutside: stale })
  const refresh = () =>
    flushSync(() => view.rerender(<Layer.Root onPointerDownOutside={current} />))
  const target = document.createElement('div')
  document.body.append(target)
  target.addEventListener('pointerdown', refresh, { once: true })
  pointer(target)
  expect(stale).not.toHaveBeenCalled()
  expect(current).toHaveBeenCalledOnce()
  target.remove()
})

function RetainedMenu({ changed }: { changed: (open: boolean) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <Dropdown.Root
      modal={false}
      open={open}
      onOpenChange={(value) => {
        changed(value)
        setOpen(value)
      }}
    >
      <Dropdown.Trigger>More</Dropdown.Trigger>
      <Dropdown.Portal forceMount>
        <Dropdown.Content forceMount onCloseAutoFocus={(event) => event.preventDefault()}>
          <Dropdown.Item>Action</Dropdown.Item>
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  )
}
it.each(['mouse', 'pen', 'keyboard'] as const)(
  'excludes only the actual %s opener and resets retained activation on reversal',
  (opening) => {
    const changed = vi.fn()
    render(<RetainedMenu changed={changed} />)
    const more = screen.getByText('More')
    const popup = screen.getByRole('menu')
    if (opening === 'keyboard') {
      fireEvent.keyDown(more, { key: 'ArrowDown' })
    } else {
      pointer(more, opening)
    }
    expect(popup).toHaveAttribute('data-state', 'open')
    expect(changed.mock.calls.map(([value]) => value)).toEqual([true])
    pointer(document.body)
    expect(popup).toHaveAttribute('data-state', 'closed')
    pointer(more)
    expect(screen.getByRole('menu')).toBe(popup)
    expect(popup).toHaveAttribute('data-state', 'open')
    pointer(document.body, 'touch')
    expect(popup).toHaveAttribute('data-state', 'closed')
    expect(changed.mock.calls.map(([value]) => value)).toEqual([true, false, true, false])
  }
)

it('uses current committed Menu callbacks while retaining active enrollment', () => {
  const stale = vi.fn()
  const current = vi.fn()
  const view = render(<RetainedMenu changed={stale} />)
  pointer(screen.getByText('More'))
  const target = document.createElement('div')
  document.body.append(target)
  target.addEventListener(
    'pointerdown',
    () => flushSync(() => view.rerender(<RetainedMenu changed={current} />)),
    { once: true }
  )
  pointer(target)
  expect(stale.mock.calls.map(([value]) => value)).toEqual([true])
  expect(current).toHaveBeenCalledExactlyOnceWith(false)
  target.remove()
})

it('kills deferred listeners on deactivation/node death and never replays them after Strict reentry', () => {
  vi.useFakeTimers()
  const dismiss = vi.fn()
  function tree(enabled: boolean, tag: 'div' | 'span') {
    const Host = tag
    return (
      <StrictMode>
        <Layer.Root
          asChild
          pointerDownOutsideEnabled={enabled}
          deferPointerDownOutside
          onDismiss={dismiss}
        >
          <Host>Content</Host>
        </Layer.Root>
      </StrictMode>
    )
  }
  const view = render(tree(true, 'div'))
  const stoppedClick = document.createElement('div')
  stoppedClick.addEventListener('click', (event) => event.stopPropagation())
  document.body.append(stoppedClick)
  pointer(stoppedClick)
  fireEvent.click(stoppedClick)
  view.rerender(tree(false, 'span'))
  fireEvent.click(document.body)
  act(() => vi.runOnlyPendingTimers())
  expect(dismiss).not.toHaveBeenCalled()
  view.rerender(tree(true, 'span'))
  fireEvent.click(document.body)
  expect(dismiss).not.toHaveBeenCalled()
  pointer(document.body)
  fireEvent.click(document.body)
  expect(dismiss).toHaveBeenCalledOnce()
  pointer(document.body)
  view.rerender(tree(true, 'div'))
  fireEvent.click(document.body)
  expect(dismiss).toHaveBeenCalledOnce()
  pointer(document.body)
  fireEvent.click(document.body)
  expect(dismiss).toHaveBeenCalledTimes(2)
  pointer(document.body)
  view.unmount()
  fireEvent.click(document.body)
  act(() => vi.runOnlyPendingTimers())
  expect(dismiss).toHaveBeenCalledTimes(2)
  stoppedClick.remove()
})

it('retires the old document enrollment and pending click when physical portal ownership changes', () => {
  vi.useFakeTimers()
  const other = document.implementation.createHTMLDocument('other')
  const dismiss = vi.fn()
  function content(container: HTMLElement) {
    return createPortal(
      <Layer.Root deferPointerDownOutside onDismiss={dismiss}>
        Content
      </Layer.Root>,
      container
    )
  }
  const view = render(content(document.body))
  pointer(document.body)
  view.rerender(content(other.body))
  fireEvent.click(document.body)
  act(() => vi.runOnlyPendingTimers())
  expect(dismiss).not.toHaveBeenCalled()
  act(() => {
    other.body.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        pointerType: 'mouse',
        button: 0
      })
    )
  })
  act(() => {
    other.body.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
    )
  })
  expect(dismiss).toHaveBeenCalledOnce()
  view.unmount()
})

it.each(['index.mjs', 'index.js'])(
  'binds the actual %s entry to its source receipt and executes its registration boundary',
  async (entry) => {
    const filename = require
      .resolve('@radix-ui/react-dismissable-layer')
      .replace(/index\.js$/, entry)
    const source = readFileSync(filename)
    const sourceHash = createHash('sha256').update(source).digest('hex')
    const expected = layerSourceHashes[entry]
    const variant = (['original', 'bad', 'candidate'] as const).find(
      (name) => expected[name] === sourceHash
    )
    expect(variant).toBeDefined()
    if (!variant) {
      throw new Error('Unrecognized actual layer source')
    }
    if (variant !== 'original') {
      expect(source.toString()).not.toContain('sourceMappingURL=')
    }
    const umbrella = require.resolve('radix-ui/dropdown-menu')
    const dropdown = createRequire(umbrella).resolve('@radix-ui/react-dropdown-menu')
    const menuEntry = createRequire(dropdown).resolve('@radix-ui/react-menu')
    const parentLayer = createRequire(menuEntry).resolve('@radix-ui/react-dismissable-layer')
    const primitive = createRequire(parentLayer).resolve('@radix-ui/react-primitive')
    expect(menuEntry).toBe(require.resolve('@radix-ui/react-menu'))
    expect(parentLayer).toBe(require.resolve('@radix-ui/react-dismissable-layer'))
    expect(readFileSync(new URL('../package.json', pathToFileURL(primitive)), 'utf8')).toContain(
      '"version": "2.1.10"'
    )
    for (const owner of [umbrella, dropdown, menuEntry, parentLayer, primitive]) {
      expect(createRequire(owner).resolve('react')).toBe(require.resolve('react'))
    }
    for (const owner of [menuEntry, parentLayer, primitive]) {
      expect(createRequire(owner).resolve('react-dom')).toBe(require.resolve('react-dom'))
    }
    console.info('F17 actual format graph', {
      entry,
      variant,
      sourceHash,
      umbrella,
      dropdown,
      menuEntry,
      parentLayer,
      primitive
    })
    const actual: typeof Layer = await import(/* @vite-ignore */ pathToFileURL(filename).href)
    vi.useFakeTimers()
    const dismiss = vi.fn()
    render(<actual.Root onDismiss={dismiss}>Actual format</actual.Root>)
    pointer(document.body)
    expect(dismiss).toHaveBeenCalledOnce()
    cleanup()
    const menuFilename = require.resolve('@radix-ui/react-menu').replace(/index\.js$/, entry)
    const menuSource = readFileSync(menuFilename)
    expect(createHash('sha256').update(menuSource).digest('hex')).toBe(
      menuSourceHashes[entry][variant]
    )
    if (variant !== 'original') {
      expect(menuSource.toString()).not.toContain('sourceMappingURL=')
    }
    const actualMenu: typeof Menu = await import(
      /* @vite-ignore */ pathToFileURL(menuFilename).href
    )
    const changed = vi.fn()
    render(
      <actualMenu.Root modal={false} open onOpenChange={changed}>
        <actualMenu.Content>Actual menu format</actualMenu.Content>
      </actualMenu.Root>
    )
    pointer(document.body)
    expect(changed).toHaveBeenCalledExactlyOnceWith(false)
  }
)

// Exact executable artifacts, not the package's now-unreferenced original maps.
const layerSourceHashes: Record<string, { original: string; bad: string; candidate: string }> = {
  'index.mjs': {
    original: '01df449a23d65bab1f2f2215a953cba74741419496ebd9a7932533f267cc873d',
    bad: 'e3dceda9d727389540709950b695cd8e327e0765462cc0a9241ccbe78018be1f',
    candidate: 'f8e5644615c804cfce8c27f052a5342a158c8bdad337b63f2108ade746a17d64'
  },
  'index.js': {
    original: '041f442853dfb1c6ff9255fc5f0e8c2fa4e50bef906ef8f4fe9b4a1f581f4f6a',
    bad: 'd8884c28b4f9f1b5b07f2efc68244f59ae018cb38ef4bad5f660fc4184f8e017',
    candidate: '313d9c4079e92f0efe2f1dd9d5f3c8fafc22d1d69885ac9188dced948cd93bd6'
  }
}
const menuSourceHashes: Record<string, { original: string; bad: string; candidate: string }> = {
  'index.mjs': {
    original: '560c738d261117e466f466a96b0f9f3c3104d7bad3a6a58898d8eba5703379f9',
    bad: '549646e4ccc53f28fd66e17809653fe975353ff12f39a2cbf5a6bee28413a056',
    candidate: '549646e4ccc53f28fd66e17809653fe975353ff12f39a2cbf5a6bee28413a056'
  },
  'index.js': {
    original: 'da3a57be196f1f7fa81b3d805c85804c3513119c9b05adb0155361c3f0080f39',
    bad: '957e8b8f371156272669e6bac82e22f6797a2ff09a49d648fb2c8b81c07d601e',
    candidate: '957e8b8f371156272669e6bac82e22f6797a2ff09a49d648fb2c8b81c07d601e'
  }
}

// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { useState } from 'react'
import { flushSync } from 'react-dom'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import * as Layer from '@radix-ui/react-dismissable-layer'
import * as Popover from 'radix-ui/popover'
import * as Dialog from 'radix-ui/dialog'
import { afterEach, expect, it, vi } from 'vitest'
import { pointer, mountLayer } from './dismissable-layer-pointer.test-fixture'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it.each([false, true])(
  'retains admitted Popover pointer delivery while Dialog commits (prevent autofocus=%s)',
  (preventAutoFocus) => {
    vi.useFakeTimers()
    const stale = vi.fn()
    const current = vi.fn()
    const interact = vi.fn()
    const focus = vi.fn()
    const lowChanged = vi.fn()
    const highChanged = vi.fn()
    const highOutside = vi.fn()
    const autofocus = vi.fn()
    const checkpoints: {
      high: string | null
      lowConnected: boolean
      modal: string
      focusedHigh: boolean
    }[] = []
    function Composition() {
      const [lowOpen, setLowOpen] = useState(true)
      const [highOpen, setHighOpen] = useState(false)
      return (
        <>
          <Popover.Root
            modal={false}
            open={lowOpen}
            onOpenChange={(open) => {
              lowChanged(open)
              setLowOpen(open)
            }}
          >
            <Popover.Trigger>Low trigger</Popover.Trigger>
            <Popover.Portal>
              <Popover.Content
                data-testid="deferred-popover"
                onPointerDownOutside={highOpen ? current : stale}
                onInteractOutside={interact}
                onFocusOutside={focus}
              >
                <button>Low action</button>
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
          <Dialog.Root
            open={highOpen}
            onOpenChange={(open) => {
              highChanged(open)
              setHighOpen(open)
            }}
          >
            <Dialog.Trigger>Open actual dialog</Dialog.Trigger>
            <Dialog.Portal>
              <Dialog.Content
                data-testid="committed-dialog"
                onPointerDownOutside={highOutside}
                onOpenAutoFocus={(event) => {
                  autofocus()
                  if (preventAutoFocus) {
                    event.preventDefault()
                  }
                }}
              >
                <Dialog.Title>Higher dialog</Dialog.Title>
                <Dialog.Description>Deferred pointer control</Dialog.Description>
                <button data-testid="dialog-focus-target">Dialog action</button>
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
        </>
      )
    }
    const view = render(<Composition />)
    act(() => vi.runOnlyPendingTimers())
    const low = screen.getByTestId('deferred-popover')
    const trigger = screen.getByText('Open actual dialog')
    const original = pointer(trigger)
    expect(stale).not.toHaveBeenCalled()
    expect(current).not.toHaveBeenCalled()
    expect(lowChanged).not.toHaveBeenCalled()
    // This listener follows React's real Trigger toggle, before native document click delivery.
    const checkpoint = () => {
      flushSync(() => {})
      checkpoints.push({
        high: screen.getByTestId('committed-dialog').getAttribute('data-state'),
        lowConnected: low.isConnected,
        modal: document.body.style.pointerEvents,
        focusedHigh: document.activeElement === screen.getByTestId('dialog-focus-target')
      })
      console.info('F17 III before document click', {
        preventAutoFocus,
        checkpoints,
        stale: stale.mock.calls.length,
        current: current.mock.calls.length,
        focus: focus.mock.calls.length,
        interact: interact.mock.calls.length
      })
      expect(stale).not.toHaveBeenCalled()
      expect(current).not.toHaveBeenCalled()
      expect(focus).not.toHaveBeenCalled()
    }
    view.container.addEventListener('click', checkpoint, { once: true })
    fireEvent.mouseDown(trigger)
    fireEvent.mouseUp(trigger)
    fireEvent.click(trigger)
    console.info('F17 III after document click', {
      low: lowChanged.mock.calls,
      high: highChanged.mock.calls,
      stale: stale.mock.calls.length,
      current: current.mock.calls.length,
      focus: focus.mock.calls.length
    })
    expect(checkpoints).toEqual([
      { high: 'open', lowConnected: true, modal: 'none', focusedHigh: !preventAutoFocus }
    ])
    expect(autofocus).toHaveBeenCalledOnce()
    expect(stale).not.toHaveBeenCalled()
    expect(current).toHaveBeenCalledOnce()
    expect(current.mock.calls[0][0].detail.originalEvent).toBe(original)
    expect(interact).toHaveBeenCalledOnce()
    expect(interact.mock.calls[0][0].detail.originalEvent).toBe(original)
    expect(focus).not.toHaveBeenCalled()
    expect(lowChanged).toHaveBeenCalledExactlyOnceWith(false)
    expect(highChanged).toHaveBeenCalledExactlyOnceWith(true)
    expect(highOutside).not.toHaveBeenCalled()
    expect(screen.queryByTestId('deferred-popover')).not.toBeInTheDocument()
    expect(screen.getByTestId('committed-dialog')).toHaveAttribute('data-state', 'open')
    console.info('F17 III controlled commit checkpoint', {
      preventAutoFocus,
      checkpoints,
      pointer: current.mock.calls.length,
      focus: focus.mock.calls.length,
      interact: interact.mock.calls.length
    })
    pointer(document.body, 'mouse', 2)
    const ctrl = new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      pointerType: 'mouse',
      ctrlKey: true
    })
    fireEvent(document.body, ctrl)
    fireEvent.click(document.body, { ctrlKey: true })
    expect(highOutside).toHaveBeenCalledTimes(2)
    expect(highOutside.mock.calls[1][0].detail.originalEvent).toBe(ctrl)
    expect(highOutside.mock.calls.every(([event]) => event.defaultPrevented)).toBe(true)
    expect(highChanged).toHaveBeenCalledExactlyOnceWith(true)
    expect(screen.getByTestId('committed-dialog')).toHaveAttribute('data-state', 'open')
  }
)

it.each(['modal', 'branch'] as const)(
  'retains current %s refusal after capture, and admits the next input after removal',
  (barrier) => {
    vi.useFakeTimers()
    const low = vi.fn()
    const order: string[] = []
    let changed = false
    const target = document.createElement('div')
    document.body.append(target)
    function tree(blocked: boolean) {
      return (
        <>
          <Layer.Root
            onPointerDownOutside={() => {
              order.push('earlier-outside')
              if (!changed) {
                changed = true
                flushSync(() => view.rerender(tree(true)))
                if (barrier === 'branch') {
                  screen.getByTestId('current-branch').append(target)
                }
                order.push('barrier-committed')
              }
            }}
          >
            Earlier
          </Layer.Root>
          <Layer.Root onPointerDownOutside={() => order.push('lower-outside')} onDismiss={low}>
            Lower
          </Layer.Root>
          {blocked &&
            (barrier === 'modal' ? (
              <Layer.Root disableOutsidePointerEvents>Higher modal</Layer.Root>
            ) : (
              <Layer.Branch data-testid="current-branch" />
            ))}
        </>
      )
    }
    const view = render(tree(false))
    act(() => vi.runOnlyPendingTimers())
    pointer(target)
    console.info('F17 IV insertion trace', {
      barrier,
      order: [...order],
      lower: low.mock.calls.length
    })
    expect(order.slice(0, 2)).toEqual(['earlier-outside', 'barrier-committed'])
    expect(low).not.toHaveBeenCalled()
    document.body.append(target)
    view.rerender(tree(false))
    act(() => vi.runOnlyPendingTimers())
    pointer(target)
    expect(low).toHaveBeenCalledOnce()
    target.remove()
  }
)

it('uses current Branch removal by a real inner pointer callback rather than capture-time Branch membership', () => {
  vi.useFakeTimers()
  const dismiss = vi.fn()
  const order: string[] = []
  function tree(branch: boolean) {
    return (
      <>
        <Layer.Root onDismiss={dismiss} onPointerDownOutside={() => order.push('lower-outside')}>
          Lower
        </Layer.Root>
        {branch && (
          <Layer.Branch>
            <button
              onPointerDown={() => {
                flushSync(() => view.rerender(tree(false)))
                order.push('branch-removed')
              }}
            >
              Remove current branch
            </button>
          </Layer.Branch>
        )}
      </>
    )
  }
  const view = render(tree(true))
  act(() => vi.runOnlyPendingTimers())
  const original = pointer(screen.getByText('Remove current branch'))
  console.info('F17 IV removal trace', { order, lower: dismiss.mock.calls.length })
  expect(original.target).not.toBeInTheDocument()
  expect(order).toEqual(['branch-removed', 'lower-outside'])
  expect(dismiss).toHaveBeenCalledOnce()
})

it('records an actually committed transient modal and original listener refresh without inventing a permission epoch', () => {
  vi.useFakeTimers()
  const add = vi.spyOn(document, 'addEventListener')
  const remove = vi.spyOn(document, 'removeEventListener')
  const low = vi.fn()
  const order: string[] = []
  let changed = false
  function tree(lower: boolean, modal: boolean) {
    return (
      <>
        <Layer.Root
          onPointerDownOutside={() => {
            order.push('earlier-outside')
            if (!changed) {
              changed = true
              flushSync(() => view.rerender(tree(true, true)))
              expect(document.body.style.pointerEvents).toBe('none')
              order.push('modal-committed')
              flushSync(() => view.rerender(tree(true, false)))
              expect(document.body.style.pointerEvents).toBe(originalBody)
              order.push('modal-removed')
            }
          }}
        >
          Earlier
        </Layer.Root>
        {lower && (
          <Layer.Root onPointerDownOutside={() => order.push('lower-outside')} onDismiss={low}>
            Lower
          </Layer.Root>
        )}
        {modal && <Layer.Root disableOutsidePointerEvents>Transient modal</Layer.Root>}
      </>
    )
  }
  const originalBody = document.body.style.pointerEvents
  const view = render(tree(false, false))
  act(() => vi.runOnlyPendingTimers())
  add.mockClear()
  view.rerender(tree(true, false))
  act(() => vi.runOnlyPendingTimers())
  const lowerListener = add.mock.calls.findLast(
    ([type, , capture]) => type === 'pointerdown' && !capture
  )?.[1]
  expect(lowerListener).toBeDefined()
  remove.mockClear()
  pointer(document.documentElement)
  const lowerRefreshes = remove.mock.calls.filter(
    ([type, listener]) => type === 'pointerdown' && listener === lowerListener
  ).length
  console.info('F17 V same-root explicit commits', {
    order,
    lowerRefreshes,
    lower: low.mock.calls.length
  })
  expect(order.slice(0, 3)).toEqual(['earlier-outside', 'modal-committed', 'modal-removed'])
  expect(low).toHaveBeenCalledOnce()
  act(() => vi.runOnlyPendingTimers())
  pointer(document.documentElement)
  expect(low).toHaveBeenCalledTimes(2)
})

it('resets an older pending click on a newly refused pointer instead of treating capture-false as absent', () => {
  vi.useFakeTimers()
  const low = mountLayer({ deferPointerDownOutside: true })
  act(() => vi.runOnlyPendingTimers())
  pointer(document.body)
  const high = render(<Layer.Root disableOutsidePointerEvents>Barrier</Layer.Root>)
  act(() => vi.runOnlyPendingTimers())
  pointer(document.body)
  high.unmount()
  fireEvent.click(document.body)
  expect(low.dismiss).not.toHaveBeenCalled()
  act(() => vi.runOnlyPendingTimers())
  pointer(document.body)
  fireEvent.click(document.body)
  expect(low.dismiss).toHaveBeenCalledOnce()
})

it('bounds capture permission reads at N and 10N actual active layers and releases them on unmount', () => {
  vi.useFakeTimers()
  const observed: { layers: number; reads: number; entries: number }[] = []
  for (const count of [2, 20]) {
    const nodes: HTMLDivElement[] = []
    const view = render(
      <>
        {Array.from({ length: count }, (_, index) => (
          <Layer.Root
            key={index}
            ref={(node) => {
              if (node && !nodes.includes(node)) {
                nodes.push(node)
              }
            }}
          >
            <button onPointerDown={(event) => event.stopPropagation()}>Inside {index}</button>
          </Layer.Root>
        ))}
      </>
    )
    act(() => vi.runOnlyPendingTimers())
    expect(nodes).toHaveLength(count)
    const from = vi.spyOn(Array, 'from')
    pointer(screen.getByText('Inside 0'))
    const reads = from.mock.calls.filter(
      ([value]) =>
        value instanceof Set && value.size === count && nodes.every((node) => value.has(node))
    ).length
    observed.push({ layers: count, reads, entries: reads * count })
    expect(reads).toBe(count)
    const layers = from.mock.calls.find(
      ([value]) =>
        value instanceof Set && value.size === count && nodes.every((node) => value.has(node))
    )?.[0]
    expect(layers).toBeInstanceOf(Set)
    view.unmount()
    from.mockClear()
    pointer(document.body)
    expect(from.mock.calls.filter(([value]) => value === layers)).toHaveLength(0)
    from.mockRestore()
  }
  expect(observed).toEqual([
    { layers: 2, reads: 2, entries: 4 },
    { layers: 20, reads: 20, entries: 400 }
  ])
})

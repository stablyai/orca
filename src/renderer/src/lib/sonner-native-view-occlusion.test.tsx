// @vitest-environment happy-dom
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { toast } from 'sonner'

import {
  getNativeViewOcclusionSnapshot,
  subscribeNativeViewOcclusion
} from '@/lib/native-view-occlusion'
import { Toaster } from '@/components/ui/sonner'

function measure(toastNode: HTMLElement, index = 0): void {
  Object.defineProperty(toastNode, 'getBoundingClientRect', {
    configurable: true,
    value: () => new DOMRect(10, 20 + index * 50, 30, 40)
  })
  toastNode.setAttribute('style', `width:30px;height:40px;--test:${index}`)
}

async function waitForToasts(
  view: ReturnType<typeof render>,
  count: number
): Promise<HTMLElement[]> {
  await waitFor(() => {
    expect(view.container.querySelectorAll<HTMLElement>('[data-sonner-toast]')).toHaveLength(count)
  })
  const nodes = Array.from(view.container.querySelectorAll<HTMLElement>('[data-sonner-toast]'))
  nodes.forEach(measure)
  await waitFor(() =>
    expect(getNativeViewOcclusionSnapshot().rectangles).toHaveLength(
      nodes.filter((node) => node.dataset.visible !== 'false' || node.dataset.expanded === 'true')
        .length
    )
  )
  return nodes
}

afterEach(() => {
  cleanup()
  toast.dismiss()
})

describe('Sonner native view occlusion', () => {
  it('registers visible toasts but not an invisible visibleToasts queue', async () => {
    const unsubscribe = subscribeNativeViewOcclusion(() => undefined)
    const view = render(<Toaster visibleToasts={1} />)
    toast('first')
    toast('queued')
    const nodes = await waitForToasts(view, 2)
    expect(nodes[0].dataset.visible).toBe('true')
    expect(nodes[1].dataset.visible).toBe('false')
    expect(getNativeViewOcclusionSnapshot().rectangles).toHaveLength(1)
    unsubscribe()
  })

  it('measures every physical toast after stack expansion', async () => {
    const unsubscribe = subscribeNativeViewOcclusion(() => undefined)
    const view = render(<Toaster visibleToasts={1} expand />)
    toast('first')
    toast('second')
    const nodes = await waitForToasts(view, 2)
    await waitFor(() => expect(nodes.every((node) => node.dataset.expanded === 'true')).toBe(true))
    expect(getNativeViewOcclusionSnapshot().rectangles).toHaveLength(2)
    unsubscribe()
  })

  it('retains dismissal occlusion until Sonner removes the physical exit node', async () => {
    const unsubscribe = subscribeNativeViewOcclusion(() => undefined)
    const view = render(<Toaster />)
    const id = toast('dismiss')
    const [node] = await waitForToasts(view, 1)
    toast.dismiss(id)
    await waitFor(() => expect(node.dataset.removed).toBe('true'))
    expect(node.isConnected).toBe(true)
    expect(getNativeViewOcclusionSnapshot().rectangles).toHaveLength(1)
    await waitFor(() => expect(node.isConnected).toBe(false), { timeout: 1000 })
    await waitFor(() => expect(getNativeViewOcclusionSnapshot().rectangles).toHaveLength(0))
    unsubscribe()
  })

  it('covers timed, promise, custom, and positioned Sonner toast DOM', async () => {
    const unsubscribe = subscribeNativeViewOcclusion(() => undefined)
    const view = render(<Toaster duration={20} />)
    toast('timed')
    const [timed] = await waitForToasts(view, 1)
    await waitFor(() => expect(timed.dataset.removed).toBe('true'), { timeout: 1000 })
    await waitFor(() => expect(timed.isConnected).toBe(false), { timeout: 1000 })

    const work = Promise.resolve('done')
    toast.promise(work, { loading: 'working', success: 'done', error: 'failed' })
    const [promiseNode] = await waitForToasts(view, 1)
    expect(promiseNode.dataset.promise).toBe('true')
    toast.custom(() => <span>custom body</span>, { position: 'top-left', duration: Infinity })
    const nodes = await waitForToasts(view, 2)
    expect(
      nodes.some((node) => node.dataset.xPosition === 'left' && node.dataset.yPosition === 'top')
    ).toBe(true)
    expect(view.getByText('custom body')).toBeTruthy()
    unsubscribe()
  })

  it('clears physical records when the owned Toaster unmounts', async () => {
    const unsubscribe = subscribeNativeViewOcclusion(() => undefined)
    const view = render(<Toaster />)
    toast('cleanup')
    await waitForToasts(view, 1)
    view.unmount()
    await waitFor(() => expect(getNativeViewOcclusionSnapshot().rectangles).toHaveLength(0))
    unsubscribe()
  })
})

// @vitest-environment happy-dom

import { useRef } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSessionRestoredBannerDismiss } from './useSessionRestoredBannerDismiss'

const mountedRoots: Root[] = []

function Probe({ visible, dismiss }: { visible: boolean; dismiss: () => void }): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  useSessionRestoredBannerDismiss(visible, ref, dismiss)
  return <div ref={ref} data-testid="pane" />
}

async function renderProbe(visible: boolean, dismiss = vi.fn()): Promise<HTMLDivElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mountedRoots.push(root)

  await act(async () => {
    root.render(<Probe visible={visible} dismiss={dismiss} />)
  })

  return container.querySelector('[data-testid="pane"]')!
}

describe('useSessionRestoredBannerDismiss', () => {
  afterEach(async () => {
    await act(async () => {
      for (const root of mountedRoots.splice(0)) {
        root.unmount()
      }
    })
    document.body.innerHTML = ''
    vi.clearAllMocks()
  })

  it('dismisses the banner on pane keyboard input', async () => {
    const dismiss = vi.fn()
    const pane = await renderProbe(true, dismiss)

    pane.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }))

    expect(dismiss).toHaveBeenCalledTimes(1)
    expect(dismiss).toHaveBeenCalledWith(expect.any(KeyboardEvent))
  })

  it('dismisses the banner on pane pointer interaction', async () => {
    const dismiss = vi.fn()
    const pane = await renderProbe(true, dismiss)

    pane.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))

    expect(dismiss).toHaveBeenCalledTimes(1)
    expect(dismiss).toHaveBeenCalledWith(expect.any(PointerEvent))
  })

  it('does not attach dismissal handlers when the banner is hidden', async () => {
    const dismiss = vi.fn()
    const pane = await renderProbe(false, dismiss)

    pane.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }))
    pane.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))

    expect(dismiss).not.toHaveBeenCalled()
  })
})

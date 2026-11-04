// @vitest-environment happy-dom

import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { usePluginReviewQueue } from './use-plugin-review-queue'
import { usePluginPageNavigation, type PluginPageNavigation } from './use-plugin-page-navigation'

let root: Root | null = null
let nav: PluginPageNavigation | null = null
let reviews: ReturnType<typeof usePluginReviewQueue> | null = null

function Harness(): React.JSX.Element {
  const queue = usePluginReviewQueue()
  reviews = queue
  nav = usePluginPageNavigation(queue.pause)
  const open = nav.open
  useEffect(() => {
    if (queue.reviewKey) {
      open(queue.reviewKey)
    }
  }, [queue.reviewKey, open])
  return (
    <>
      <input aria-label="field" />
      <div role="dialog">
        <button>inside dialog</button>
      </div>
      <button data-plain>plain</button>
      <button data-back onClick={nav.back}>
        Back
      </button>
    </>
  )
}

async function mountOpen(): Promise<HTMLDivElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root?.render(<Harness />))
  await act(async () => nav?.open('acme.notes'))
  return container
}

function pressBack(target: Element | null): void {
  target?.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true, bubbles: true })
  )
}

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

describe('usePluginPageNavigation', () => {
  it.each(['button', 'keyboard'])(
    'pauses review on Back via %s, reopens the same plugin and accepts later update-all reviews',
    async (method) => {
      const container = await mountOpen()
      await act(async () => reviews?.show('acme.notes'))
      const back = (): void => {
        if (method === 'button') {
          container.querySelector<HTMLButtonElement>('[data-back]')?.click()
        } else {
          pressBack(container.querySelector('[data-plain]'))
        }
      }
      await act(async () => back())
      expect(nav?.openKey).toBeNull()
      expect(reviews?.reviewKey).toBeNull()
      await act(async () => reviews?.show('acme.notes'))
      expect(nav?.openKey).toBe('acme.notes')
      await act(async () => back())
      await act(async () => reviews?.enqueue(['acme.tasks', 'acme.third']))
      expect(nav?.openKey).toBe('acme.tasks')
      await act(async () =>
        reviews?.advance([
          {
            pluginKey: 'acme.third',
            consentFingerprint: null,
            name: 'Third',
            version: '1.0.0',
            publisher: 'acme',
            status: 'pending',
            needsReconsent: true,
            isDev: false,
            official: false,
            bundled: false,
            capabilities: [],
            panels: [],
            commands: [],
            hasWorker: false,
            restarts: 0
          }
        ])
      )
      expect(nav?.openKey).toBe('acme.third')
    }
  )

  it('leaves Alt+← to text fields and dialogs', async () => {
    const container = await mountOpen()
    await act(async () => pressBack(container.querySelector('input')))
    await act(async () => pressBack(container.querySelector('[role="dialog"] button')))
    expect(nav?.openKey).toBe('acme.notes')
  })
})

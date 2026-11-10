// @vitest-environment happy-dom

import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { PluginHostListEntry } from '../../../../../preload/api-types'
import { usePluginReviewQueue } from './use-plugin-review-queue'
import { usePluginPageNavigation, type PluginPageNavigation } from './use-plugin-page-navigation'

let root: Root | null = null
let nav: PluginPageNavigation | null = null
let reviews: ReturnType<typeof usePluginReviewQueue> | null = null

function pending(pluginKey: string): PluginHostListEntry {
  return {
    pluginKey,
    consentFingerprint: null,
    name: pluginKey,
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
}

function Harness(): React.JSX.Element {
  const queue = usePluginReviewQueue()
  reviews = queue
  nav = usePluginPageNavigation(queue.navigate)
  const open = nav.open
  useEffect(() => {
    if (queue.reviewKey) {
      open(queue.reviewKey, { replace: queue.replacePage })
    }
  }, [queue.reviewKey, queue.replacePage, open])
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
      <div data-plugin-key="acme.notes">
        <button data-plugin-row-name>Notes</button>
      </div>
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
  it('returns through detail pages with Back and Alt+Left, then focuses the original list entry', async () => {
    const container = await mountOpen()
    await act(async () => nav?.open('acme.icons'))
    await act(async () => nav?.open('acme.third'))
    await act(async () => container.querySelector<HTMLButtonElement>('[data-back]')?.click())
    expect(nav?.openKey).toBe('acme.icons')
    await act(async () => pressBack(container.querySelector('[data-plain]')))
    expect(nav?.openKey).toBe('acme.notes')
    await act(async () => pressBack(container.querySelector('[data-plain]')))
    expect(nav?.openKey).toBeNull()
    expect(document.activeElement).toBe(container.querySelector('[data-plugin-row-name]'))
  })

  it('pauses A when visiting B, keeps B decisions outside the queue, and resumes A before the next review', async () => {
    await mountOpen()
    await act(async () => reviews?.enqueue(['acme.notes', 'acme.third']))
    await act(async () =>
      reviews?.advance('acme.icons', [pending('acme.notes'), pending('acme.third')])
    )
    expect(reviews?.reviewKey).toBe('acme.notes')
    await act(async () => nav?.open('acme.icons'))
    await act(async () =>
      reviews?.advance('acme.icons', [pending('acme.notes'), pending('acme.third')])
    )
    expect(nav?.openKey).toBe('acme.icons')
    expect(reviews?.reviewKey).toBeNull()

    await act(async () => nav?.back())
    expect(nav?.openKey).toBe('acme.notes')
    expect(reviews?.reviewKey).toBe('acme.notes')
    await act(async () => reviews?.advance('acme.notes', [pending('acme.third')]))
    expect(nav?.openKey).toBe('acme.third')
    await act(async () => nav?.back())
    expect(nav?.openKey).toBeNull()
  })

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
      await act(async () => reviews?.advance('acme.notes', []))
      await act(async () => back())
      await act(async () => reviews?.enqueue(['acme.tasks', 'acme.third']))
      expect(nav?.openKey).toBe('acme.tasks')
      await act(async () => reviews?.advance('acme.tasks', [pending('acme.third')]))
      expect(nav?.openKey).toBe('acme.third')
      await act(async () => back())
      expect(nav?.openKey).toBeNull()
    }
  )
})

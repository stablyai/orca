// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StarNagCard } from './StarNagCard'

type ShowPayload = { mode?: 'gh' | 'web'; surface?: 'card' | 'toast' }
type ShowCallback = (payload?: ShowPayload) => void

type StarNagApi = {
  onShow: (callback: ShowCallback) => () => void
  onHide: (callback: () => void) => () => void
  dismiss: ReturnType<typeof vi.fn>
  later: ReturnType<typeof vi.fn>
  openWeb: ReturnType<typeof vi.fn>
  starOrca: ReturnType<typeof vi.fn>
}

type ShellApi = {
  openUrl: ReturnType<typeof vi.fn>
}

function setApi(api: { starNag: StarNagApi; shell: ShellApi }): void {
  ;(window as unknown as { api: typeof api }).api = api
}

function renderCard(): { root: Root; container: HTMLDivElement } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(<StarNagCard />)
  })
  return { root, container }
}

describe('StarNagCard', () => {
  let root: Root | null = null
  let container: HTMLDivElement | null = null
  let showCallback: ShowCallback | null = null
  let starNag: StarNagApi
  let shell: ShellApi

  beforeEach(() => {
    showCallback = null
    starNag = {
      onShow: vi.fn((callback: ShowCallback) => {
        showCallback = callback
        return vi.fn()
      }),
      onHide: vi.fn(() => vi.fn()),
      dismiss: vi.fn().mockResolvedValue(undefined),
      later: vi.fn().mockResolvedValue(undefined),
      openWeb: vi.fn().mockResolvedValue(undefined),
      starOrca: vi.fn().mockResolvedValue(true)
    }
    shell = {
      openUrl: vi.fn().mockResolvedValue(undefined)
    }
    setApi({ starNag, shell })
  })

  afterEach(() => {
    if (root) {
      act(() => root?.unmount())
    }
    container?.remove()
    root = null
    container = null
  })

  it('switches to the explicit GitHub fallback when direct starring fails', async () => {
    starNag.starOrca.mockResolvedValueOnce(false)
    ;({ root, container } = renderCard())

    act(() => showCallback?.({ mode: 'gh', surface: 'card' }))
    expect(container.textContent).toContain('Star on GitHub')
    const initialButton = Array.from(container.querySelectorAll('button')).find((candidate) =>
      candidate.textContent?.includes('Star on GitHub')
    )
    expect(initialButton?.className).toContain('bg-amber-400/15')
    expect(initialButton?.parentElement?.className).toContain('flex gap-2')

    await act(async () => {
      initialButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(starNag.starOrca).toHaveBeenCalledTimes(1)
    expect(shell.openUrl).not.toHaveBeenCalled()
    expect(starNag.openWeb).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Open GitHub')
    const fallbackButton = Array.from(container.querySelectorAll('button')).find((candidate) =>
      candidate.textContent?.includes('Open GitHub')
    )
    expect(fallbackButton?.className).toContain('bg-amber-400/15')
    expect(fallbackButton?.parentElement?.textContent).toContain('Later')
  })
})

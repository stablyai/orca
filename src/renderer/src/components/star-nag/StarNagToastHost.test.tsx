// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StarNagToastHost } from './StarNagToastHost'

type ShowPayload = { mode?: 'gh' | 'web'; surface?: 'card' | 'toast' }
type ShowCallback = (payload?: ShowPayload) => void
type CustomToastOptions = {
  dismissible?: boolean
  onDismiss?: () => void
}

const toastDismissMock = vi.hoisted(() => vi.fn())
const customToastMock = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({
  toast: {
    custom: customToastMock,
    dismiss: toastDismissMock
  }
}))

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

function createDeferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve
  })
  return { promise, resolve }
}

function setApi(api: { starNag: StarNagApi; shell: ShellApi }): void {
  ;(window as unknown as { api: typeof api }).api = api
}

function renderHost(): { root: Root; container: HTMLDivElement } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(<StarNagToastHost />)
  })
  return { root, container }
}

function renderToastFromCustomCall(container: HTMLElement): void {
  const render = customToastMock.mock.calls[0][0] as (id: string | number) => React.ReactElement
  act(() => {
    createRoot(container).render(render('toast-1'))
  })
}

describe('StarNagToastHost', () => {
  let root: Root | null = null
  let container: HTMLDivElement | null = null
  let toastContainer: HTMLDivElement | null = null
  let showCallback: ShowCallback | null = null
  let hideCallback: (() => void) | null = null
  let starNag: StarNagApi
  let shell: ShellApi
  let toastIdCounter = 0

  beforeEach(() => {
    customToastMock.mockReset()
    customToastMock.mockImplementation(() => `toast-${++toastIdCounter}`)
    toastDismissMock.mockReset()
    showCallback = null
    hideCallback = null
    toastIdCounter = 0
    starNag = {
      onShow: vi.fn((callback: ShowCallback) => {
        showCallback = callback
        return vi.fn()
      }),
      onHide: vi.fn((callback: () => void) => {
        hideCallback = callback
        return vi.fn()
      }),
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
    toastContainer?.remove()
    root = null
    container = null
    toastContainer = null
  })

  it('renders exact onboarding toast copy and confirms only after direct star succeeds', async () => {
    ;({ root, container } = renderHost())

    act(() => showCallback?.({ mode: 'gh', surface: 'toast' }))
    toastContainer = document.createElement('div')
    document.body.appendChild(toastContainer)
    renderToastFromCustomCall(toastContainer)

    expect(toastContainer.textContent).toContain('Onboarding completed!')
    expect(toastContainer.textContent).toContain(
      'If you’re enjoying Orca so far, a GitHub star helps other developers discover it.'
    )
    expect(toastContainer.textContent).toContain('Star on GitHub')
    expect((customToastMock.mock.calls[0][1] as CustomToastOptions).dismissible).toBe(false)

    const button = Array.from(toastContainer.querySelectorAll('button')).find((candidate) =>
      candidate.textContent?.includes('Star on GitHub')
    )
    expect(button?.className).toContain('flex-1')
    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(starNag.starOrca).toHaveBeenCalledTimes(1)
    expect(toastContainer.textContent).toContain('Starred — thank you!')
  })

  it('opens GitHub fallback without calling direct star success path', async () => {
    ;({ root, container } = renderHost())

    act(() => showCallback?.({ mode: 'web', surface: 'toast' }))
    toastContainer = document.createElement('div')
    document.body.appendChild(toastContainer)
    renderToastFromCustomCall(toastContainer)

    const button = Array.from(toastContainer.querySelectorAll('button')).find((candidate) =>
      candidate.textContent?.includes('Open GitHub')
    )
    expect(button?.className).toContain('bg-amber-400/15')
    expect(button?.className).toContain('text-amber-800')
    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(shell.openUrl).toHaveBeenCalledWith('https://github.com/stablyai/orca')
    expect(starNag.openWeb).toHaveBeenCalledTimes(1)
    expect(starNag.starOrca).not.toHaveBeenCalled()
    expect(toastContainer.textContent).toContain('GitHub opened')
    expect(toastContainer.textContent).not.toContain('GitHub opened in your browser.')
  })

  it('switches to the explicit GitHub fallback when direct star fails', async () => {
    starNag.starOrca.mockResolvedValueOnce(false)
    ;({ root, container } = renderHost())

    act(() => showCallback?.({ mode: 'gh', surface: 'toast' }))
    toastContainer = document.createElement('div')
    document.body.appendChild(toastContainer)
    renderToastFromCustomCall(toastContainer)

    const button = Array.from(toastContainer.querySelectorAll('button')).find((candidate) =>
      candidate.textContent?.includes('Star on GitHub')
    )
    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(starNag.starOrca).toHaveBeenCalledTimes(1)
    expect(shell.openUrl).not.toHaveBeenCalled()
    expect(starNag.openWeb).not.toHaveBeenCalled()
    expect(toastContainer.textContent).toContain('Open GitHub')
    const fallbackButton = Array.from(toastContainer.querySelectorAll('button')).find((candidate) =>
      candidate.textContent?.includes('Open GitHub')
    )
    expect(fallbackButton?.className).toContain('bg-amber-400/15')
    expect(fallbackButton?.className).toContain('text-amber-800')
    expect(toastContainer.textContent).toContain('Later')
  })

  it('routes Later and unresolved close through existing star nag paths', () => {
    ;({ root, container } = renderHost())

    act(() => showCallback?.({ mode: 'gh', surface: 'toast' }))
    toastContainer = document.createElement('div')
    document.body.appendChild(toastContainer)
    renderToastFromCustomCall(toastContainer)

    const laterButton = Array.from(toastContainer.querySelectorAll('button')).find((candidate) =>
      candidate.textContent?.includes('Later')
    )
    act(() => {
      laterButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(starNag.later).toHaveBeenCalledTimes(1)

    const options = customToastMock.mock.calls[0][1] as CustomToastOptions
    act(() => options.onDismiss?.())
    expect(starNag.dismiss).not.toHaveBeenCalled()

    act(() => showCallback?.({ mode: 'gh', surface: 'toast' }))
    const closeOptions = customToastMock.mock.calls[1][1] as CustomToastOptions
    act(() => closeOptions.onDismiss?.())

    expect(starNag.dismiss).toHaveBeenCalledTimes(1)
  })

  it('does not allow unresolved close while the primary action is busy', async () => {
    const pendingStar = createDeferred<boolean>()
    starNag.starOrca.mockReturnValueOnce(pendingStar.promise)
    ;({ root, container } = renderHost())

    act(() => showCallback?.({ mode: 'gh', surface: 'toast' }))
    toastContainer = document.createElement('div')
    document.body.appendChild(toastContainer)
    renderToastFromCustomCall(toastContainer)

    const starButton = Array.from(toastContainer.querySelectorAll('button')).find((candidate) =>
      candidate.textContent?.includes('Star on GitHub')
    )
    await act(async () => {
      starButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const closeButton = Array.from(toastContainer.querySelectorAll('button')).find(
      (candidate) => candidate.getAttribute('aria-label') === 'Dismiss'
    )
    expect((closeButton as HTMLButtonElement | undefined)?.disabled).toBe(true)
    act(() => {
      closeButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const options = customToastMock.mock.calls[0][1] as CustomToastOptions
    act(() => options.onDismiss?.())

    expect(toastDismissMock).not.toHaveBeenCalled()
    expect(starNag.dismiss).not.toHaveBeenCalled()

    await act(async () => {
      pendingStar.resolve(true)
      await pendingStar.promise
    })
  })

  it('does not dismiss the current main session when replacing an active toast', () => {
    ;({ root, container } = renderHost())

    act(() => showCallback?.({ mode: 'gh', surface: 'toast' }))
    const firstOptions = customToastMock.mock.calls[0][1] as CustomToastOptions

    act(() => showCallback?.({ mode: 'web', surface: 'toast' }))
    const secondOptions = customToastMock.mock.calls[1][1] as CustomToastOptions
    act(() => firstOptions.onDismiss?.())

    expect(toastDismissMock).toHaveBeenCalledWith('toast-1')
    expect(starNag.dismiss).not.toHaveBeenCalled()

    act(() => showCallback?.({ mode: 'gh', surface: 'toast' }))
    const thirdOptions = customToastMock.mock.calls[2][1] as CustomToastOptions
    act(() => secondOptions.onDismiss?.())

    expect(starNag.dismiss).not.toHaveBeenCalled()

    act(() => thirdOptions.onDismiss?.())

    expect(starNag.dismiss).toHaveBeenCalledTimes(1)
  })

  it('dismisses active toast on hide without recording a user dismissal', () => {
    ;({ root, container } = renderHost())

    act(() => showCallback?.({ mode: 'gh', surface: 'toast' }))
    act(() => hideCallback?.())
    const options = customToastMock.mock.calls[0][1] as CustomToastOptions
    act(() => options.onDismiss?.())

    expect(toastDismissMock).toHaveBeenCalledWith('toast-1')
    expect(starNag.dismiss).not.toHaveBeenCalled()
  })
})

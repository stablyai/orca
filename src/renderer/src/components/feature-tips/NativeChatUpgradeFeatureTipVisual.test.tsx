// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NativeChatUpgradeFeatureTipVisual } from './NativeChatUpgradeFeatureTipVisual'

const prefersReducedMotionMock = vi.hoisted(() => vi.fn(() => false))

vi.mock('@/components/feature-wall/feature-wall-modal-helpers', () => ({
  usePrefersReducedMotion: prefersReducedMotionMock
}))

async function renderVisual(): Promise<{
  container: HTMLDivElement
  root: Root
}> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => root.render(<NativeChatUpgradeFeatureTipVisual />))
  return { container, root }
}

function menuOpen(container: HTMLElement, kind: 'chat' | 'cli'): string | null | undefined {
  return container
    .querySelector(`[data-testid="native-chat-upgrade-${kind}-menu"]`)
    ?.getAttribute('data-open')
}

function highlightedItems(container: HTMLElement, kind: 'chat' | 'cli'): string[] {
  return Array.from(
    container.querySelectorAll(
      `[data-testid="native-chat-upgrade-${kind}-menu"] [data-highlighted="true"]`
    )
  ).map((item) => item.textContent ?? '')
}

describe('NativeChatUpgradeFeatureTipVisual', () => {
  beforeEach(() => {
    prefersReducedMotionMock.mockReturnValue(false)
  })

  afterEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('is decorative and shows both real Agent Session History actions', async () => {
    const { container, root } = await renderVisual()
    const visual = container.firstElementChild

    expect(visual?.getAttribute('aria-hidden')).toBe('true')
    expect(container.textContent).toContain('Agent Session History')
    expect(highlightedItems(container, 'chat')).toEqual(['Resume in New CLI'])
    expect(highlightedItems(container, 'cli')).toEqual(['Resume in New Native Chat'])

    await act(async () => root.unmount())
  })

  it('explains that going to the CLI forks and leaves the native chat in place', async () => {
    const { container, root } = await renderVisual()
    const chatMenu = container.querySelector('[data-testid="native-chat-upgrade-chat-menu"]')

    expect(chatMenu?.textContent).toContain('Forks this conversation into a new CLI session.')
    expect(chatMenu?.textContent).toContain('The native chat stays as it is.')

    await act(async () => root.unmount())
  })

  it('alternates between the chat row menu and the CLI row menu', async () => {
    vi.useFakeTimers()
    const { container, root } = await renderVisual()

    expect(menuOpen(container, 'chat')).toBe('true')
    expect(menuOpen(container, 'cli')).toBe('false')

    await act(async () => vi.advanceTimersByTime(3600))
    expect(menuOpen(container, 'chat')).toBe('false')
    expect(menuOpen(container, 'cli')).toBe('true')

    await act(async () => vi.advanceTimersByTime(3600))
    expect(menuOpen(container, 'chat')).toBe('true')

    await act(async () => root.unmount())
    expect(vi.getTimerCount()).toBe(0)
  })

  it('holds the fork scene without timers for reduced motion', async () => {
    prefersReducedMotionMock.mockReturnValue(true)
    const setTimeoutSpy = vi.spyOn(window, 'setTimeout')
    const { container, root } = await renderVisual()

    expect(menuOpen(container, 'chat')).toBe('true')
    expect(menuOpen(container, 'cli')).toBe('false')
    expect(setTimeoutSpy).not.toHaveBeenCalled()

    await act(async () => root.unmount())
  })
})

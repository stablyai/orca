// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VoiceDictationFeatureTipVisual } from './VoiceDictationFeatureTipVisual'

const prefersReducedMotionMock = vi.hoisted(() => vi.fn(() => false))
const shortcutMock = vi.hoisted(() => vi.fn(() => ({ keys: ['⌘', 'E'], doubleTap: false })))

vi.mock('@/components/feature-wall/feature-wall-modal-helpers', () => ({
  usePrefersReducedMotion: prefersReducedMotionMock
}))

vi.mock('@/hooks/useShortcutLabel', () => ({
  useShortcutKeyDetails: shortcutMock
}))

async function renderVisual(): Promise<{ container: HTMLDivElement; root: Root }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => root.render(<VoiceDictationFeatureTipVisual />))
  return { container, root }
}

describe('VoiceDictationFeatureTipVisual', () => {
  beforeEach(() => {
    prefersReducedMotionMock.mockReturnValue(false)
    shortcutMock.mockReturnValue({ keys: ['⌘', 'E'], doubleTap: false })
  })

  afterEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('types the dictated prompt once and settles on the complete sentence', async () => {
    vi.useFakeTimers()
    const { container, root } = await renderVisual()
    const prompt = container.querySelector('[data-testid="dictated-prompt"]')

    expect(prompt?.textContent).toBe('')
    await act(async () => vi.advanceTimersByTime(650))
    expect(prompt?.textContent).toBe('R')
    await act(async () => vi.runAllTimers())
    expect(prompt?.textContent).toBe(
      'Review this diff for edge cases and add tests for anything you find.'
    )
    expect(vi.getTimerCount()).toBe(0)

    await act(async () => root.unmount())
  })

  it('gives the prompt the full remaining row width', () => {
    const html = renderToStaticMarkup(<VoiceDictationFeatureTipVisual />)
    const promptClass = html.match(/data-testid="dictated-prompt" class="([^"]+)"/)?.[1]

    expect(promptClass).toContain('min-w-0')
    expect(promptClass).toContain('flex-1')
    expect(promptClass).not.toContain('max-w-')
  })

  it('renders the completed prompt without timers for reduced motion', async () => {
    prefersReducedMotionMock.mockReturnValue(true)
    const setTimeoutSpy = vi.spyOn(window, 'setTimeout')
    const { container, root } = await renderVisual()

    expect(container.textContent).toContain(
      'Review this diff for edge cases and add tests for anything you find.'
    )
    expect(container.innerHTML).not.toContain('animate-waveform')
    expect(setTimeoutSpy).not.toHaveBeenCalled()

    await act(async () => root.unmount())
  })

  it('does not show a shortcut that the user has unassigned', () => {
    shortcutMock.mockReturnValue({ keys: [], doubleTap: false })

    const html = renderToStaticMarkup(<VoiceDictationFeatureTipVisual />)

    expect(html).not.toContain('Start dictation')
    expect(html).not.toContain('Ctrl')
  })
})

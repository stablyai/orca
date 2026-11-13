// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AutomationPromptDisclosure } from './AutomationPromptDisclosure'

const END_MARKER = 'SYNTHETIC-END-MARKER'
const LONG_PROMPT = [
  'Synthetic prompt preview validation only.',
  '',
  ...Array.from(
    { length: 20 },
    (_, index) =>
      `Synthetic step ${index + 1}: inspect placeholder input and summarize placeholder output.`
  ),
  '',
  END_MARKER
].join('\n')

// Why: happy-dom has no layout, so the clamped paragraph's overflow is driven by these values.
const layout = { scrollHeight: 0, clientHeight: 0 }
const resizeCallbacks = new Set<() => void>()

class ResizeObserverStub {
  private readonly callback: () => void
  constructor(callback: () => void) {
    this.callback = callback
  }
  observe(): void {
    resizeCallbacks.add(this.callback)
  }
  unobserve(): void {}
  disconnect(): void {
    resizeCallbacks.delete(this.callback)
  }
}

const writeClipboardText = vi.fn<(text: string) => Promise<void>>()

beforeEach(() => {
  layout.scrollHeight = 0
  layout.clientHeight = 0
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(
    () => layout.scrollHeight
  )
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(
    () => layout.clientHeight
  )
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  writeClipboardText.mockReset().mockResolvedValue(undefined)
  Object.assign(window, { api: { ui: { writeClipboardText } } })
})

afterEach(() => {
  cleanup()
  resizeCallbacks.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function renderPrompt(prompt: string): void {
  render(
    <TooltipProvider>
      <AutomationPromptDisclosure prompt={prompt} />
    </TooltipProvider>
  )
}

function promptFor(toggle: HTMLElement): HTMLElement {
  const id = toggle.getAttribute('aria-controls')
  const element = id ? document.getElementById(id) : null
  if (!element) {
    throw new Error('Toggle does not control a prompt element')
  }
  return element
}

describe('AutomationPromptDisclosure', () => {
  it('shows a short prompt in full without an expand control', () => {
    layout.scrollHeight = 40
    layout.clientHeight = 40
    renderPrompt('Synthetic short prompt.')

    expect(screen.getByText('Synthetic short prompt.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull()
  })

  it('collapses a long prompt behind Show more and reveals all of it on expand', () => {
    layout.scrollHeight = 600
    layout.clientHeight = 160
    renderPrompt(LONG_PROMPT)

    const showMore = screen.getByRole('button', { name: 'Show more' })
    expect(showMore.getAttribute('aria-expanded')).toBe('false')
    const prompt = promptFor(showMore)
    expect(prompt.textContent).toBe(LONG_PROMPT)

    showMore.focus()
    fireEvent.click(showMore)

    const showLess = screen.getByRole('button', { name: 'Show less' })
    expect(showLess.getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(showLess)
    expect(promptFor(showLess)).toBe(prompt)
    expect(prompt.textContent).toContain(END_MARKER)

    fireEvent.click(showLess)
    expect(screen.getByRole('button', { name: 'Show more' }).getAttribute('aria-expanded')).toBe(
      'false'
    )
  })

  it('drops the expand control and keeps focus on the prompt when it stops overflowing', () => {
    layout.scrollHeight = 300
    layout.clientHeight = 160
    renderPrompt(`Synthetic resize focus validation. ${'placeholder '.repeat(48)}`)

    const showMore = screen.getByRole('button', { name: 'Show more' })
    const prompt = promptFor(showMore)
    showMore.focus()

    layout.scrollHeight = 160
    act(() => {
      for (const callback of resizeCallbacks) {
        callback()
      }
    })

    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull()
    expect(document.activeElement).toBe(prompt)
  })

  it('copies the full prompt text', async () => {
    layout.scrollHeight = 600
    layout.clientHeight = 160
    renderPrompt(LONG_PROMPT)

    fireEvent.click(screen.getByRole('button', { name: 'Copy prompt' }))

    expect(writeClipboardText).toHaveBeenCalledTimes(1)
    expect(writeClipboardText).toHaveBeenCalledWith(LONG_PROMPT)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy())
  })
})

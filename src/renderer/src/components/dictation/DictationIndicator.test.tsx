// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_DICTATION_METER, type DictationMeterState } from './dictation-audio-meter'
import { DictationIndicator } from './DictationIndicator'
import { useAppStore } from '@/store'

const speakingMeter: DictationMeterState = {
  level: 0.72,
  peak: 0.74,
  isSpeaking: true,
  isSilent: false,
  isClipping: false,
  lastUpdatedAt: 100
}

const clippingMeter: DictationMeterState = {
  ...speakingMeter,
  isClipping: true,
  peak: 1
}

let root: Root | null = null
let container: HTMLDivElement | null = null

globalThis.IS_REACT_ACT_ENVIRONMENT = true

function resetDictationState(): void {
  useAppStore.setState({
    dictationState: 'idle',
    partialTranscript: '',
    dictationMeter: DEFAULT_DICTATION_METER,
    dictationNotice: null
  })
}

async function mountIndicator(): Promise<HTMLDivElement> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(<DictationIndicator />)
  })
  return container
}

beforeEach(() => {
  resetDictationState()
})

afterEach(async () => {
  if (root) {
    await act(async () => {
      root?.unmount()
    })
  }
  root = null
  container?.remove()
  container = null
  vi.useRealTimers()
  resetDictationState()
})

describe('DictationIndicator', () => {
  it('is hidden when idle without a notice', () => {
    expect(renderToStaticMarkup(<DictationIndicator />)).toBe('')
  })

  it('uses bottom-center placement', async () => {
    useAppStore.setState({ dictationState: 'listening' })

    const mounted = await mountIndicator()

    expect(mounted.innerHTML).toContain('bottom-12')
    expect(mounted.innerHTML).toContain('-translate-x-1/2')
    expect(mounted.innerHTML).not.toContain('top-12')
  })

  it('renders listening state for silent input', async () => {
    useAppStore.setState({ dictationState: 'listening' })

    expect((await mountIndicator()).textContent).toContain('Listening')
  })

  it('renders speaking state for active input', async () => {
    useAppStore.setState({ dictationState: 'listening', dictationMeter: speakingMeter })

    expect((await mountIndicator()).textContent).toContain('Speaking')
  })

  it('renders clipping state with destructive styling', async () => {
    useAppStore.setState({ dictationState: 'listening', dictationMeter: clippingMeter })

    const mounted = await mountIndicator()

    expect(mounted.textContent).toContain('Too loud')
    expect(mounted.innerHTML).toContain('border-destructive/35')
    expect(mounted.innerHTML).toContain('text-destructive')
  })

  it('keeps the tail of long transcripts and drops the oldest prefix', async () => {
    const oldestPrefix = 'OLDEST_PREFIX_THAT_SHOULD_BE_DROPPED '
    const newestPhrase = 'and the newest words must remain visible'
    useAppStore.setState({
      dictationState: 'listening',
      dictationMeter: speakingMeter,
      partialTranscript: `${oldestPrefix}${'filler word '.repeat(8)}${newestPhrase}`
    })

    const text = (await mountIndicator()).textContent ?? ''

    // Leading ellipsis marks the dropped prefix; the newest phrase survives.
    expect(text).toContain('…')
    expect(text).not.toContain(oldestPrefix)
    expect(text).toContain(newestPhrase)
  })

  it('keeps the most recent words visible and shows a pinned ellipsis on overflow', async () => {
    const newestPhrase = 'walk me through the most recent changes you pushed?'
    useAppStore.setState({
      dictationState: 'listening',
      dictationMeter: speakingMeter,
      partialTranscript: `Can you inspect the repository, summarize the current branch, and then ${newestPhrase}`
    })

    const mounted = await mountIndicator()
    const html = mounted.innerHTML
    const text = mounted.textContent ?? ''

    // Transcript lives in a paragraph (second row), not inline in the control row.
    expect(html).toContain('<p')
    // Fixed, bounded width so it grows downward instead of sprawling right.
    expect(html).toContain('w-[min(26rem,calc(100vw-2rem))]')
    // The newest words must always survive: justify the tail to the end so the
    // overflow spills off the start (oldest words). Tailwind's `truncate`
    // end-ellipsizes and would hide the tail.
    expect(html).not.toContain('truncate')
    expect(html).toContain('overflow-hidden')
    expect(html).toContain('justify-end')
    expect(html).toContain('whitespace-nowrap')
    // The truncation marker renders as a visible standalone prefix span, not
    // clipped away inside the overflow region.
    expect(html).toContain('<span class="shrink-0">…</span>')
    // The final words of the utterance are present in the rendered text.
    expect(text).toContain(newestPhrase)
  })

  it('omits the ellipsis prefix for short transcripts that are not truncated', async () => {
    useAppStore.setState({
      dictationState: 'listening',
      dictationMeter: speakingMeter,
      partialTranscript: 'Short transcript'
    })

    const mounted = await mountIndicator()

    expect(mounted.textContent).toContain('Short transcript')
    expect(mounted.innerHTML).not.toContain('<span class="shrink-0">…</span>')
  })

  it('renders processing state while stopping', async () => {
    useAppStore.setState({ dictationState: 'stopping' })

    expect((await mountIndicator()).textContent).toContain('Processing…')
  })

  it('renders an error notice without making dictation non-idle', async () => {
    useAppStore.setState({
      dictationState: 'idle',
      dictationNotice: { kind: 'error', message: 'Speech error.', createdAt: 1 }
    })

    const mounted = await mountIndicator()

    expect(mounted.textContent).toContain('Speech error.')
    expect(mounted.innerHTML).toContain('text-destructive')
    expect(useAppStore.getState().dictationState).toBe('idle')
  })

  it('clears notices after three seconds', async () => {
    vi.useFakeTimers()
    useAppStore.setState({
      dictationNotice: { kind: 'info', message: 'No speech detected.', createdAt: 1 }
    })
    await mountIndicator()

    await act(async () => {
      vi.advanceTimersByTime(3_000)
    })

    expect(useAppStore.getState().dictationNotice).toBeNull()
  })
})

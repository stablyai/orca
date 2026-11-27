// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { BotPictureCarousel, type BotPictureFace } from './BotPictureCarousel'

const KEYS = ['a', 'b', 'c', 'd', 'e', 'f']
const FACES: BotPictureFace[] = KEYS.map((key) => ({
  key,
  src: `data:image/png;base64,${key}`,
  outfit: { src: `data:image/webp;base64,${key}`, at: [0, 0, 128, 128] },
  fallback: ''
}))

function carousel(index: number): React.JSX.Element {
  return (
    <TooltipProvider>
      <BotPictureCarousel
        faces={FACES}
        index={index}
        dropping={false}
        description=""
        onIndexChange={() => {}}
      />
    </TooltipProvider>
  )
}

function dressed(key: string): boolean {
  return document.querySelector(`[data-face="${key}"] img[src^="data:image/webp"]`) !== null
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('BotPictureCarousel outfits while sliding', () => {
  it('keeps a leaving face dressed for a full slide after a late change of face', () => {
    const { rerender } = render(carousel(1))
    fireEvent.click(document.querySelector('[data-face="c"]')!)
    rerender(carousel(2))
    act(() => vi.advanceTimersByTime(50))
    // A pasted picture takes another face, then is refused and the face comes back.
    rerender(carousel(3))
    act(() => vi.advanceTimersByTime(330))
    rerender(carousel(2))
    act(() => vi.advanceTimersByTime(300))

    expect(dressed('a')).toBe(true)
    act(() => vi.advanceTimersByTime(200))
    expect(dressed('a')).toBe(false)
  })

  it('starts no slide from a click on the current face', () => {
    const { rerender } = render(carousel(1))
    fireEvent.click(document.querySelector('[data-face="b"][data-position="current"]')!)
    // A pasted picture moves the face within the slide time.
    act(() => vi.advanceTimersByTime(100))
    rerender(carousel(2))

    expect(dressed('a')).toBe(false)
  })
})

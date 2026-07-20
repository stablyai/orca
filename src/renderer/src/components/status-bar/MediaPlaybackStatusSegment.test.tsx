// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MediaPlaybackStatusSegment } from './MediaPlaybackStatusSegment'

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => children,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <span>{children}</span>
}))

describe('MediaPlaybackStatusSegment', () => {
  let container: HTMLDivElement
  let root: Root
  const getStatus = vi.fn()

  beforeEach(() => {
    getStatus.mockReset()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { mediaPlayback: { getStatus } }
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('shows the player mark and emphasizes the track title before the artist', async () => {
    getStatus.mockResolvedValue({
      player: 'spotify',
      state: 'paused',
      artist: 'AtHeart',
      track: 'Say It'
    })

    await act(async () => {
      root.render(<MediaPlaybackStatusSegment compact={false} iconOnly={false} />)
      await Promise.resolve()
    })

    const status = container.querySelector('[role="status"]')
    const title = status?.querySelector('[data-media-track-title]')
    const artist = status?.querySelector('[data-media-track-artist]')

    expect(status?.querySelector('[data-media-player="spotify"] svg')).not.toBeNull()
    expect(status?.textContent).toBe('Say It — AtHeart')
    expect(status?.textContent).not.toContain('Spotify')
    expect(title?.textContent).toBe('Say It')
    expect(title?.className).toContain('font-semibold')
    expect(title?.className).toContain('text-foreground')
    expect(artist?.className).toContain('text-muted-foreground')
    expect(status?.getAttribute('aria-label')).toBe('Spotify · Paused · AtHeart — Say It')
  })

  it('keeps the narrow status bar icon-only', async () => {
    getStatus.mockResolvedValue({
      player: 'apple-music',
      state: 'playing',
      artist: 'Artist',
      track: 'Track'
    })

    await act(async () => {
      root.render(<MediaPlaybackStatusSegment compact iconOnly />)
      await Promise.resolve()
    })

    const status = container.querySelector('[role="status"]')
    expect(status).not.toBeNull()
    expect(status?.querySelector('[data-media-player="apple-music"] svg')).not.toBeNull()
    expect(status?.textContent).toBe('')
    expect(status?.getAttribute('aria-label')).toBe('Apple Music · Playing · Artist — Track')
  })
})

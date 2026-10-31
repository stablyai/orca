// @vitest-environment happy-dom

import { StrictMode, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mediaPlaybackPositionCache } from '@/lib/scroll-cache'
import MediaViewer from './MediaViewer'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

describe('MediaViewer', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    mediaPlaybackPositionCache.clear()
  })

  const renderPlaybackViewer = async (
    playbackCacheKey: string,
    duration = 60
  ): Promise<{ root: Root; video: HTMLVideoElement }> => {
    const container = document.createElement('div')
    const root = createRoot(container)
    await act(async () =>
      root.render(
        <StrictMode>
          <MediaViewer
            src="orca-media://file/token"
            mimeType="video/mp4"
            filePath="clip.mp4"
            canOpenLocally
            playbackCacheKey={playbackCacheKey}
          />
        </StrictMode>
      )
    )
    const video = container.querySelector('video')
    if (!video) {
      throw new Error('video not rendered')
    }
    Object.defineProperty(video, 'duration', { configurable: true, value: duration })
    return { root, video }
  }

  it('keeps its source through Strict Mode setup and stops playback on unmount', async () => {
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    const load = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
    const container = document.createElement('div')
    const root = createRoot(container)
    await act(async () =>
      root.render(
        <StrictMode>
          <MediaViewer
            src="orca-media://file/token"
            mimeType="video/mp4"
            filePath="clip.mp4"
            canOpenLocally
          />
        </StrictMode>
      )
    )
    const video = container.querySelector('video')
    expect(video?.getAttribute('src')).toBe('orca-media://file/token')
    expect(video?.controls).toBe(true)
    expect(video?.autoplay).toBe(false)
    expect(video?.preload).toBe('metadata')
    pause.mockClear()
    load.mockClear()
    await act(async () => root.unmount())
    expect(pause).toHaveBeenCalledTimes(1)
    expect(load).toHaveBeenCalledTimes(1)
    expect(video?.getAttribute('src')).toBeNull()
  })

  it('retains the position when leaving before metadata and clamps it when the file shrinks', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
    const first = await renderPlaybackViewer('clip.mp4:pdf')
    first.video.currentTime = 42
    await act(async () => first.root.unmount())

    const loading = await renderPlaybackViewer('clip.mp4:pdf', Number.NaN)
    await act(async () => loading.root.unmount())

    const shorter = await renderPlaybackViewer('clip.mp4:pdf', 20)
    await act(async () => shorter.video.dispatchEvent(new Event('loadedmetadata')))
    expect(shorter.video.currentTime).toBe(20)
    await act(async () => shorter.root.unmount())
  })

  it('keeps separate view positions and restarts a completed clip', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
    const firstPane = await renderPlaybackViewer('clip.mp4::pane-a:pdf')
    firstPane.video.currentTime = 12
    await act(async () => firstPane.root.unmount())

    const otherPane = await renderPlaybackViewer('clip.mp4::pane-b:pdf')
    await act(async () => otherPane.video.dispatchEvent(new Event('loadedmetadata')))
    expect(otherPane.video.currentTime).toBe(0)
    otherPane.video.currentTime = 27
    await act(async () => otherPane.root.unmount())

    const restored = await renderPlaybackViewer('clip.mp4::pane-a:pdf')
    await act(async () => restored.video.dispatchEvent(new Event('loadedmetadata')))
    expect(restored.video.currentTime).toBe(12)
    Object.defineProperty(restored.video, 'ended', { configurable: true, value: true })
    await act(async () => restored.root.unmount())

    const completed = await renderPlaybackViewer('clip.mp4::pane-a:pdf')
    await act(async () => completed.video.dispatchEvent(new Event('loadedmetadata')))
    expect(completed.video.currentTime).toBe(0)
    await act(async () => completed.root.unmount())

    const otherRestored = await renderPlaybackViewer('clip.mp4::pane-b:pdf')
    await act(async () => otherRestored.video.dispatchEvent(new Event('loadedmetadata')))
    expect(otherRestored.video.currentTime).toBe(27)
    await act(async () => otherRestored.root.unmount())
  })

  it('uses native audio controls and releases the audio source when switching files', async () => {
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    const load = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
    const container = document.createElement('div')
    const root = createRoot(container)
    await act(async () =>
      root.render(
        <StrictMode>
          <MediaViewer
            key="song"
            src="orca-media://file/song"
            mimeType="audio/mpeg"
            filePath="song.mp3"
            canOpenLocally
          />
        </StrictMode>
      )
    )
    const audio = container.querySelector('audio')
    expect(audio?.getAttribute('src')).toBe('orca-media://file/song')
    expect(audio?.controls).toBe(true)
    expect(audio?.autoplay).toBe(false)
    expect(audio?.preload).toBe('metadata')
    expect(audio?.getAttribute('aria-label')).toBe('song.mp3')
    expect(container.querySelector('video')).toBeNull()
    pause.mockClear()
    load.mockClear()
    await act(async () =>
      root.render(
        <MediaViewer
          key="clip"
          src="orca-media://file/clip"
          mimeType="video/mp4"
          filePath="clip.mp4"
          canOpenLocally
        />
      )
    )
    expect(pause).toHaveBeenCalledTimes(1)
    expect(load).toHaveBeenCalledTimes(1)
    expect(audio?.getAttribute('src')).toBeNull()
    expect(container.querySelector('audio')).toBeNull()
    expect(container.querySelector('video')?.getAttribute('src')).toBe('orca-media://file/clip')
    await act(async () => root.unmount())
  })
})

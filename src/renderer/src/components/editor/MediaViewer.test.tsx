// @vitest-environment happy-dom

import { StrictMode, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  mediaPlaybackStateCache,
  mediaVolumePreference
} from '@/components/editor/model-lifetime/retention/editor-view-state-cache'
import MediaViewer from './MediaViewer'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

describe('MediaViewer', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    mediaPlaybackStateCache.clear()
    mediaVolumePreference.volume = 1
    mediaVolumePreference.muted = false
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

  it('shares volume and mute across previews and keeps each clip at its own speed', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
    // Unfinalized WebM recordings report an Infinity duration.
    const first = await renderPlaybackViewer('clip.mp4:pdf', Number.POSITIVE_INFINITY)
    await act(async () => first.video.dispatchEvent(new Event('loadedmetadata')))
    first.video.volume = 0.25
    first.video.muted = true
    first.video.playbackRate = 1.5
    await act(async () => first.video.dispatchEvent(new Event('volumechange')))
    Object.defineProperty(first.video, 'ended', { configurable: true, value: true })
    await act(async () => first.root.unmount())

    const other = await renderPlaybackViewer('other.mp4:pdf')
    await act(async () => other.video.dispatchEvent(new Event('loadedmetadata')))
    expect(other.video.volume).toBe(0.25)
    expect(other.video.muted).toBe(true)
    expect(other.video.playbackRate).toBe(1)
    await act(async () => other.root.unmount())

    const restored = await renderPlaybackViewer('clip.mp4:pdf', Number.POSITIVE_INFINITY)
    await act(async () => restored.video.dispatchEvent(new Event('loadedmetadata')))
    expect(restored.video.playbackRate).toBe(1.5)
    await act(async () => restored.root.unmount())
  })

  it('saves a volume change still queued at teardown without overwriting a newer choice', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
    const idle = await renderPlaybackViewer('idle.mp4:left')
    const active = await renderPlaybackViewer('active.mp4:right')
    active.video.volume = 0.5
    await act(async () => active.video.dispatchEvent(new Event('volumechange')))
    await act(async () => idle.root.unmount())
    expect(mediaVolumePreference).toEqual({ volume: 0.5, muted: false })

    active.video.muted = true
    await act(async () => active.root.unmount())
    expect(mediaVolumePreference).toEqual({ volume: 0.5, muted: true })
  })
})

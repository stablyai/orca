// @vitest-environment happy-dom

import { StrictMode, act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import MediaViewer from './MediaViewer'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

describe('MediaViewer', () => {
  afterEach(() => vi.restoreAllMocks())

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

  it('shows a persistent playback error and only offers the default app for local files', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
    const container = document.createElement('div')
    const root = createRoot(container)
    await act(async () =>
      root.render(
        <MediaViewer
          src="orca-media://file/token"
          mimeType="video/mp4"
          filePath="remote.mp4"
          canOpenLocally={false}
        />
      )
    )
    await act(async () => container.querySelector('video')?.dispatchEvent(new Event('error')))
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Unable to play this media file'
    )
    expect(container.querySelector('button')).toBeNull()
    await act(async () => root.unmount())
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

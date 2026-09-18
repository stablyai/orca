import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearBrowserPageProgress,
  consumePendingBrowserPageProgressRestoration,
  formatRestoredBrowserUrl,
  getBrowserPageProgress,
  recordBrowserPageProgress,
  restoreBrowserPageProgress,
  stageBrowserPageProgressRestoration,
  captureBrowserPageProgress,
  ensureBrowserPageProgressTracking,
  stopBrowserPageProgressTracking
} from './browser-page-progress-retention'
import { webviewRegistry } from './webview-registry'

describe('browser-page-progress-retention', () => {
  beforeEach(() => {
    clearBrowserPageProgress('tab-1')
    clearBrowserPageProgress('tab-2')
    webviewRegistry.clear()
    stopBrowserPageProgressTracking()
  })

  afterEach(() => {
    stopBrowserPageProgressTracking()
  })

  it('records, retrieves, and clears browser page progress snapshots', () => {
    expect(getBrowserPageProgress('tab-1')).toBeNull()

    recordBrowserPageProgress('tab-1', {
      url: 'https://youtube.com/watch?v=xyz',
      scrollX: 0,
      scrollY: 150,
      media: { currentTime: 45.2, paused: false, playbackRate: 1 },
      timestamp: Date.now()
    })

    const snapshot = getBrowserPageProgress('tab-1')
    expect(snapshot).not.toBeNull()
    expect(snapshot?.url).toBe('https://youtube.com/watch?v=xyz')
    expect(snapshot?.media?.currentTime).toBe(45.2)

    clearBrowserPageProgress('tab-1')
    expect(getBrowserPageProgress('tab-1')).toBeNull()
  })

  it('stages and consumes pending restorations once per remount', () => {
    recordBrowserPageProgress('tab-1', {
      url: 'https://example.com',
      scrollX: 10,
      scrollY: 200,
      media: null,
      timestamp: Date.now()
    })

    const staged = stageBrowserPageProgressRestoration('tab-1')
    expect(staged).not.toBeNull()
    expect(staged?.scrollY).toBe(200)

    const consumed = consumePendingBrowserPageProgressRestoration('tab-1')
    expect(consumed).toEqual(staged)

    // Second consume returns null because it was already consumed
    expect(consumePendingBrowserPageProgressRestoration('tab-1')).toBeNull()
  })

  it('formats YouTube URLs with playback timestamp parameter', () => {
    expect(
      formatRestoredBrowserUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ', {
        currentTime: 75.8,
        paused: false,
        playbackRate: 1
      })
    ).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=75s')

    // Overwrites existing t parameter with latest playback time
    expect(
      formatRestoredBrowserUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10s', {
        currentTime: 90,
        paused: false,
        playbackRate: 1
      })
    ).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90s')

    // Supports youtu.be shortlinks
    expect(
      formatRestoredBrowserUrl('https://youtu.be/dQw4w9WgXcQ', {
        currentTime: 30,
        paused: false,
        playbackRate: 1
      })
    ).toBe('https://youtu.be/dQw4w9WgXcQ?t=30s')

    // Supports music.youtube.com
    expect(
      formatRestoredBrowserUrl('https://music.youtube.com/watch?v=dQw4w9WgXcQ', {
        currentTime: 120,
        paused: false,
        playbackRate: 1
      })
    ).toBe('https://music.youtube.com/watch?v=dQw4w9WgXcQ&t=120s')

    // Leaves non-YouTube URLs intact
    expect(
      formatRestoredBrowserUrl('https://example.com/video', {
        currentTime: 45,
        paused: false,
        playbackRate: 1
      })
    ).toBe('https://example.com/video')

    // Leaves URLs intact when currentTime is 0 or absent
    expect(
      formatRestoredBrowserUrl('https://www.youtube.com/watch?v=abc', {
        currentTime: 0,
        paused: false,
        playbackRate: 1
      })
    ).toBe('https://www.youtube.com/watch?v=abc')
  })

  it('captures browser page progress from webview via executeJavaScript', async () => {
    const mockWebview = {
      executeJavaScript: vi.fn().mockResolvedValue({
        url: 'https://youtube.com/watch?v=xyz',
        scrollX: 0,
        scrollY: 50,
        media: {
          currentTime: 102.5,
          paused: false,
          playbackRate: 1
        }
      })
    } as unknown as Electron.WebviewTag

    const captured = await captureBrowserPageProgress('tab-1', mockWebview)
    expect(captured).not.toBeNull()
    expect(captured?.url).toBe('https://youtube.com/watch?v=xyz')
    expect(captured?.media?.currentTime).toBe(102.5)
    expect(captured?.media?.paused).toBe(false)
    expect(getBrowserPageProgress('tab-1')).toEqual(captured)
  })

  it('restores browser page scroll and media state via executeJavaScript', () => {
    const mockWebview = {
      executeJavaScript: vi.fn().mockResolvedValue(undefined)
    } as unknown as Electron.WebviewTag

    restoreBrowserPageProgress(mockWebview, {
      url: 'https://youtube.com/watch?v=xyz',
      scrollX: 10,
      scrollY: 250,
      media: {
        currentTime: 65,
        paused: false,
        playbackRate: 1.25
      },
      timestamp: Date.now()
    })

    expect(mockWebview.executeJavaScript).toHaveBeenCalledOnce()
    const script = vi.mocked(mockWebview.executeJavaScript).mock.calls[0][0] as string
    expect(script).toContain('window.scrollTo')
    expect(script).toContain('250')
    expect(script).toContain('media.currentTime = targetTime')
  })

  it('pauses restored media that was paused at capture', () => {
    const mockWebview = {
      executeJavaScript: vi.fn().mockResolvedValue(undefined)
    } as unknown as Electron.WebviewTag

    restoreBrowserPageProgress(mockWebview, {
      url: 'https://youtube.com/watch?v=xyz',
      scrollX: 0,
      scrollY: 0,
      media: {
        currentTime: 65,
        paused: true,
        playbackRate: 1
      },
      timestamp: Date.now()
    })

    expect(mockWebview.executeJavaScript).toHaveBeenCalledOnce()
    const script = vi.mocked(mockWebview.executeJavaScript).mock.calls[0][0] as string
    // Why: a restored page can autoplay — without the pause branch a video
    // paused at capture resumes playing after every restore.
    expect(script).toContain('const wasPaused = true')
    expect(script).toContain('media.pause()')
  })

  it('starts and stops progress tracking timer safely', () => {
    ensureBrowserPageProgressTracking()
    // Repeated call is safe and idempotent
    ensureBrowserPageProgressTracking()
    stopBrowserPageProgressTracking()
  })

  it('samples live page progress on a low-frequency safety-net interval', async () => {
    vi.useFakeTimers()
    try {
      const webview = {
        executeJavaScript: vi.fn().mockResolvedValue({
          url: 'https://example.com',
          scrollX: 0,
          scrollY: 40,
          media: null
        })
      } as unknown as Electron.WebviewTag
      webviewRegistry.set('tab-1', webview)

      ensureBrowserPageProgressTracking()
      await vi.advanceTimersByTimeAsync(1000)
      expect(webview.executeJavaScript).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(4000)
      expect(webview.executeJavaScript).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

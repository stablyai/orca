import { describe, expect, it } from 'vitest'
import {
  formatByteCount,
  formatDownloadFinishedNotice,
  formatLoadFailureDescription,
  formatPermissionNotice,
  formatPopupNotice,
  isCertificateLoadError
} from './browser-notices'
import { BROWSER_GUEST_RECOVERY_ERROR_CODE } from '../host-guest/browser-page-guest-recovery'
import { describeBrowserLoadFailure } from '../../../../../shared/browser-load-failure'

describe('browser notice formatting', () => {
  it('formats denied permissions with safe copy', () => {
    expect(
      formatPermissionNotice({
        browserPageId: 'browser-1',
        permission: 'media',
        origin: 'https://example.com'
      })
    ).toBe('https://example.com asked for camera or microphone access, and Orca denied it.')
    expect(
      formatPermissionNotice({
        browserPageId: 'browser-1',
        permission: 'geolocation',
        origin: 'unknown'
      })
    ).toBe('this page asked for your location, and Orca denied it.')
  })

  it.each([
    ['storage-access', 'access to its own cookies and storage while embedded on this page'],
    ['top-level-storage-access', 'cookie access on behalf of an embedded site'],
    ['idle-detection', 'permission to detect when you are idle'],
    ['display-capture', 'permission to capture your screen'],
    ['window-management', 'screen information and multi-screen window placement'],
    ['keyboardLock', 'permission to capture keyboard input'],
    ['openExternal', 'permission to open a link outside Orca'],
    ['fileSystem', 'access to your files or folders'],
    ['hid', 'access to a connected human interface device'],
    ['usb', 'access to a USB device'],
    ['serial', 'access to a serial device'],
    ['midi', 'access to your MIDI devices'],
    ['midiSysex', 'access to system-exclusive MIDI messages'],
    ['mediaKeySystem', 'access to protected media playback'],
    ['speaker-selection', 'permission to choose an audio output device']
  ])('formats the %s permission as readable copy', (permission, description) => {
    expect(
      formatPermissionNotice({
        browserPageId: 'browser-1',
        permission,
        origin: 'https://example.com'
      })
    ).toBe(`https://example.com asked for ${description}, and Orca denied it.`)
  })

  it('falls back to the raw permission name for anything unmapped', () => {
    expect(
      formatPermissionNotice({
        browserPageId: 'browser-1',
        permission: 'some-future-permission',
        origin: 'https://example.com'
      })
    ).toBe('https://example.com asked for some-future-permission, and Orca denied it.')
  })

  it('formats popup outcomes', () => {
    expect(
      formatPopupNotice({
        browserPageId: 'browser-1',
        origin: 'https://example.com',
        action: 'opened-in-orca'
      })
    ).toBeNull()

    expect(
      formatPopupNotice({
        browserPageId: 'browser-1',
        origin: 'https://example.com',
        action: 'opened-external'
      })
    ).toBe('https://example.com opened a new window in your default browser.')

    expect(
      formatPopupNotice({
        browserPageId: 'browser-1',
        origin: 'unknown',
        action: 'blocked'
      })
    ).toBe('A site tried to open a popup Orca does not support here.')
  })

  it('formats download completion and byte counts', () => {
    expect(
      formatDownloadFinishedNotice({
        downloadId: 'download-1',
        status: 'completed',
        savePath: '/tmp/report.csv',
        error: null
      })
    ).toBe('Downloaded to /tmp/report.csv.')

    expect(
      formatDownloadFinishedNotice({
        downloadId: 'download-2',
        status: 'failed',
        savePath: null,
        error: 'Download failed.'
      })
    ).toBe('Download failed.')

    expect(formatByteCount(512)).toBe('512 B')
    expect(formatByteCount(1024)).toBe('1.0 KB')
    expect(formatByteCount(5 * 1024 * 1024)).toBe('5.0 MB')
  })

  it('preserves the explicit guest recovery failure copy', () => {
    const loadError = {
      code: BROWSER_GUEST_RECOVERY_ERROR_CODE,
      description: 'The browser page stopped unexpectedly. Retry to restore it.',
      validatedUrl: 'http://localhost:3000'
    }
    expect(
      formatLoadFailureDescription(loadError, describeBrowserLoadFailure(loadError, null))
    ).toBe('The browser page stopped unexpectedly. Retry to restore it.')
  })

  it('formats certificate failures', () => {
    const loadError = (code: number) => ({
      code,
      description: 'certificate error',
      validatedUrl: 'https://localhost:3443/'
    })
    const describeCode = (code: number) =>
      formatLoadFailureDescription(
        loadError(code),
        describeBrowserLoadFailure(loadError(code), null)
      )

    expect(describeCode(-200)).toBe("The certificate doesn't match localhost:3443.")
    expect(describeCode(-201)).toBe(
      "The certificate for localhost:3443 isn't valid at the current date and time."
    )
    expect(describeCode(-202)).toBe(
      "Orca doesn't trust the authority that issued the certificate for localhost:3443."
    )
    expect(describeCode(-208)).toBe("Orca couldn't verify the certificate for localhost:3443.")
    expect(isCertificateLoadError(loadError(-219))).toBe(true)
    expect(isCertificateLoadError(loadError(-215))).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import {
  formatByteCount,
  formatDownloadFinishedNotice,
  formatLoadFailureDescription,
  formatLoadFailureRecoveryHint,
  formatPermissionNotice,
  formatPopupNotice,
  isCertificateLoadError
} from './browser-notices'

describe('browser notice formatting', () => {
  it('formats denied permissions with safe copy', () => {
    expect(
      formatPermissionNotice({
        browserPageId: 'browser-1',
        permission: 'media',
        origin: 'https://example.com'
      })
    ).toBe('https://example.com asked for camera or microphone access, and Orca denied it.')
  })

  it('formats popup outcomes', () => {
    expect(
      formatPopupNotice({
        browserPageId: 'browser-1',
        origin: 'https://example.com',
        action: 'opened-in-orca'
      })
    ).toBe('https://example.com opened a new page in Orca.')

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

  it('formats load failure copy for localhost and remote pages', () => {
    expect(
      formatLoadFailureDescription(
        {
          code: -102,
          description: 'ERR_CONNECTION_REFUSED',
          validatedUrl: 'http://localhost:3000'
        },
        {
          host: 'localhost:3000',
          isLocalhostLike: true
        }
      )
    ).toBe("We couldn't connect to your local server.")

    expect(
      formatLoadFailureRecoveryHint({
        host: 'localhost:3000',
        isLocalhostLike: true
      })
    ).toBe(
      'If this should be a local app, make sure the server is running and listening on the expected port.'
    )

    expect(
      formatLoadFailureDescription(
        {
          code: -105,
          description: 'ERR_NAME_NOT_RESOLVED',
          validatedUrl: 'https://example.com'
        },
        {
          host: 'example.com',
          isLocalhostLike: false
        }
      )
    ).toBe("We couldn't connect to this page.")

    expect(
      formatLoadFailureRecoveryHint({
        host: 'example.com',
        isLocalhostLike: false
      })
    ).toBeNull()
  })

  it('formats certificate failures without local-server recovery advice', () => {
    const meta = { host: 'localhost:3443', isLocalhostLike: true }
    const loadError = (code: number) => ({
      code,
      description: 'certificate error',
      validatedUrl: 'https://localhost:3443/'
    })

    expect(formatLoadFailureDescription(loadError(-200), meta)).toBe(
      "The certificate doesn't match localhost:3443."
    )
    expect(formatLoadFailureDescription(loadError(-201), meta)).toBe(
      "The certificate for localhost:3443 isn't valid at the current date and time."
    )
    expect(formatLoadFailureDescription(loadError(-202), meta)).toBe(
      "Orca doesn't trust the authority that issued the certificate for localhost:3443."
    )
    expect(formatLoadFailureDescription(loadError(-208), meta)).toBe(
      "Orca couldn't verify the certificate for localhost:3443."
    )
    expect(isCertificateLoadError(loadError(-219))).toBe(true)
    expect(isCertificateLoadError(loadError(-215))).toBe(false)
    expect(formatLoadFailureRecoveryHint(meta, loadError(-202))).toBeNull()
  })
})

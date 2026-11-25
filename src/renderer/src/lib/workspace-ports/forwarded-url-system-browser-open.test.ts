import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PortForwardEntry } from '../../../../shared/remote-runtime/ssh/ssh-types'

const failures = vi.hoisted(() => ({ shown: 0 }))
vi.mock('@/lib/browser/workspace/workspace-browser-open-failure-toast', () => ({
  showBrowserOpenFailure: () => {
    failures.shown++
  }
}))
vi.mock('sonner', () => ({ toast: { info: vi.fn() } }))

const { openForwardedUrlInSystemBrowser, openSshRoutedUrlInSystemBrowser } =
  await import('./forwarded-url-system-browser-open')

// Local 3000 reaches the SSH host's port 4000.
const forward: PortForwardEntry = {
  id: 'pf-1',
  connectionId: 'target',
  localPort: 3000,
  remoteHost: 'localhost',
  remotePort: 4000
}

function stubShell(shell: Record<string, unknown>): void {
  vi.stubGlobal('window', { api: { shell } })
}

afterEach(() => {
  vi.unstubAllGlobals()
  failures.shown = 0
})

describe('forwarded system-browser opens', () => {
  it('report a failed launch on the plain fallback instead of the URL', async () => {
    stubShell({ openUrl: () => Promise.reject(new Error('launch refused')) })

    const opened = await openForwardedUrlInSystemBrowser('http://localhost:3000/', forward, 'ssh')

    expect(opened).toBeNull()
    expect(failures.shown).toBe(1)
  })

  it('open a name the page resolver treats as public as is, not through a forward', async () => {
    const openUrl = vi.fn(() => Promise.resolve())
    const openForwardedUrl = vi.fn(() =>
      Promise.resolve({ opened: true, url: '', movedToIpv4: false })
    )
    stubShell({ openUrl, openForwardedUrl })

    openSshRoutedUrlInSystemBrowser('http://dev_.localhost.:3000/', [forward])
    openSshRoutedUrlInSystemBrowser('http://app.localhost.:3000/', [forward])

    await vi.waitFor(() => expect(openUrl).toHaveBeenCalledTimes(1))
    expect(openUrl).toHaveBeenCalledWith('http://dev_.localhost.:3000/')
    expect(openForwardedUrl).toHaveBeenCalledTimes(1)
    expect(openForwardedUrl).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'http://app.localhost.:3000/', forwardId: 'pf-1' })
    )
  })
})

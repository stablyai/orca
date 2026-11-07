import { beforeEach, describe, expect, it, vi } from 'vitest'

type ToastButton = { label: string; onClick: () => void }
type ToastOptions = { id?: string; duration?: number; action?: ToastButton; cancel?: ToastButton }

const { shown } = vi.hoisted(() => {
  const toasts: ToastOptions[] = []
  return { shown: toasts }
})

vi.mock('sonner', () => ({
  toast: {
    info: vi.fn((_title: string, options: ToastOptions) => shown.push(options)),
    success: vi.fn(),
    error: vi.fn()
  }
}))

import { showRemoteHostBrowserControlNotice } from './remote-host-browser-control-notice'

describe('showRemoteHostBrowserControlNotice', () => {
  beforeEach(() => {
    shown.length = 0
  })

  it('stays up without blocking and relays Stop and Don’t allow for that host', () => {
    const stop = vi.fn(async () => {})
    const disallow = vi.fn(async () => true)

    showRemoteHostBrowserControlNotice(
      { targetId: 'ssh-1', hostLabel: 'build-box', canDisallow: true },
      { stop, disallow }
    )
    const [notice] = shown
    expect(notice.duration).toBe(Number.POSITIVE_INFINITY)
    notice.action?.onClick()
    notice.cancel?.onClick()

    expect(stop).toHaveBeenCalledWith('ssh-1')
    expect(disallow).toHaveBeenCalledWith('ssh-1')
  })

  it('offers only Stop for a host whose settings Orca owns', () => {
    showRemoteHostBrowserControlNotice(
      { targetId: 'runtime-ssh-1', hostLabel: 'sandbox', canDisallow: false },
      { stop: vi.fn(async () => {}), disallow: vi.fn(async () => false) }
    )

    expect(shown[0]?.action).toBeDefined()
    expect(shown[0]?.cancel).toBeUndefined()
  })
})

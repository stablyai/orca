// @vitest-environment happy-dom

import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  DeveloperPermissionRequestResult,
  DeveloperPermissionState
} from '../../../../shared/developer-permissions-types'
import {
  FullDiskAccessSetupPrompt,
  isFullDiskAccessReady,
  isFullDiskAccessSetupVisible
} from './FullDiskAccessSetupPrompt'
import { toast } from 'sonner'

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    message: vi.fn(),
    success: vi.fn()
  }
}))

function setUserAgent(userAgent: string): void {
  Object.defineProperty(window.navigator, 'userAgent', {
    value: userAgent,
    configurable: true
  })
}

function installDeveloperPermissionsApi(args: {
  getStatus: () => Promise<DeveloperPermissionState[]>
  request?: () => Promise<DeveloperPermissionRequestResult>
}): void {
  Object.assign(window, {
    api: {
      developerPermissions: {
        getStatus: vi.fn(args.getStatus),
        request: vi.fn(
          args.request ??
            (async () => ({
              id: 'full-disk-access',
              status: 'unknown',
              openedSystemSettings: true
            }))
        )
      }
    }
  })
}

async function renderPrompt(): Promise<{ container: HTMLDivElement; root: Root }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(React.createElement(FullDiskAccessSetupPrompt))
  })
  await act(async () => {
    await Promise.resolve()
  })
  return { container, root }
}

describe('FullDiskAccessSetupPrompt state helpers', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    document.body.innerHTML = ''
    Reflect.deleteProperty(window, 'api')
    Object.defineProperty(window.navigator, 'userAgent', {
      value: '',
      configurable: true
    })
  })

  it('hides the setup prompt before status is known or when unsupported', () => {
    expect(isFullDiskAccessSetupVisible(undefined)).toBe(false)
    expect(isFullDiskAccessSetupVisible('unsupported')).toBe(false)
  })

  it('shows the setup prompt for macOS statuses users can act on', () => {
    expect(isFullDiskAccessSetupVisible('unknown')).toBe(true)
    expect(isFullDiskAccessSetupVisible('denied')).toBe(true)
    expect(isFullDiskAccessSetupVisible('granted')).toBe(true)
  })

  it('treats granted and entitled statuses as ready', () => {
    expect(isFullDiskAccessReady('granted')).toBe(true)
    expect(isFullDiskAccessReady('ready')).toBe(true)
    expect(isFullDiskAccessReady('unknown')).toBe(false)
  })

  it('refreshes macOS Full Disk Access status when Orca regains focus', async () => {
    setUserAgent('Macintosh')
    const getStatus = vi
      .fn()
      .mockResolvedValueOnce([{ id: 'full-disk-access', status: 'unknown' }])
      .mockResolvedValueOnce([{ id: 'full-disk-access', status: 'granted' }])
    installDeveloperPermissionsApi({ getStatus })

    const { container, root } = await renderPrompt()
    expect(container.textContent).toContain('Recommended')

    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      await Promise.resolve()
    })

    expect(getStatus).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain('Granted')
    root.unmount()
  })

  it('keeps the latest macOS status when overlapping refreshes finish out of order', async () => {
    setUserAgent('Macintosh')
    let resolveFirst!: (states: DeveloperPermissionState[]) => void
    const firstRefresh = new Promise<DeveloperPermissionState[]>((resolve) => {
      resolveFirst = resolve
    })
    const getStatus = vi
      .fn()
      .mockReturnValueOnce(firstRefresh)
      .mockResolvedValueOnce([{ id: 'full-disk-access', status: 'granted' }])
    installDeveloperPermissionsApi({ getStatus })

    const { container, root } = await renderPrompt()
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      await Promise.resolve()
    })
    expect(container.textContent).toContain('Granted')

    await act(async () => {
      resolveFirst([{ id: 'full-disk-access', status: 'unknown' }])
      await Promise.resolve()
    })

    expect(container.textContent).toContain('Granted')
    root.unmount()
  })

  it('does not query or render the macOS Full Disk Access prompt on non-macOS', async () => {
    setUserAgent('Windows NT 10.0')
    const getStatus = vi.fn().mockResolvedValue([{ id: 'full-disk-access', status: 'unknown' }])
    installDeveloperPermissionsApi({ getStatus })

    const { container, root } = await renderPrompt()

    expect(container.textContent).not.toContain('Full Disk Access')
    expect(getStatus).not.toHaveBeenCalled()
    expect(window.api.developerPermissions.request).not.toHaveBeenCalled()
    root.unmount()
  })

  it('opens Full Disk Access settings from the prompt action', async () => {
    setUserAgent('Macintosh')
    installDeveloperPermissionsApi({
      getStatus: async () => [{ id: 'full-disk-access', status: 'unknown' }],
      request: async () => ({
        id: 'full-disk-access',
        status: 'unknown',
        openedSystemSettings: true
      })
    })

    const { container, root } = await renderPrompt()
    const button = container.querySelector<HTMLButtonElement>('button')
    expect(button?.textContent).toContain('Open Full Disk Access')

    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    expect(window.api.developerPermissions.request).toHaveBeenCalledWith({
      id: 'full-disk-access'
    })
    expect(toast.message).toHaveBeenCalledWith('Opened macOS Privacy & Security')
    root.unmount()
  })
})

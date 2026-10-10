// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { DeveloperPermissionState } from '../../../../shared/developer-permissions-types'
import { FULL_DISK_ACCESS_SETTINGS_TARGET_ID } from '@/lib/settings-navigation-types'
import { DeveloperPermissionsPane } from './DeveloperPermissionsPane'

const toastMessageMock = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    message: toastMessageMock,
    success: vi.fn()
  }
}))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  Object.assign(window, {
    api: {
      developerPermissions: {
        getStatus: vi.fn(async (): Promise<DeveloperPermissionState[]> => [
          { id: 'full-disk-access', status: 'denied' }
        ]),
        request: vi.fn(async ({ id }: { id: string }) => ({
          id,
          status: 'unknown',
          openedSystemSettings: false
        })),
        openSettings: vi.fn()
      }
    }
  })
  toastMessageMock.mockReset()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  Reflect.deleteProperty(window, 'api')
})

function setPermissionStates(states: DeveloperPermissionState[]): void {
  const api = (window as unknown as { api: { developerPermissions: { getStatus: unknown } } }).api
  api.developerPermissions.getStatus = vi.fn(async () => states)
}

it('requests Local Network access without claiming a permission verdict', async () => {
  setPermissionStates([{ id: 'local-network', status: 'unknown' }])

  await act(async () => {
    root.render(<DeveloperPermissionsPane />)
  })

  const row = container.querySelector<HTMLElement>(
    '[data-settings-section="developer-permissions-local-network"]'
  )
  const [requestButton, settingsButton] = Array.from(
    row?.querySelectorAll<HTMLButtonElement>('button') ?? []
  )
  expect(row?.textContent).toContain('Managed by macOS')
  expect(row?.textContent).toContain("macOS does not report this permission's current status")
  expect(requestButton?.textContent).toContain('Request Access')
  expect(settingsButton?.textContent).toContain('Open System Settings')

  await act(async () => requestButton?.click())

  const api = window.api.developerPermissions
  expect(api.request).toHaveBeenCalledWith({ id: 'local-network' })
  expect(toastMessageMock).toHaveBeenCalledWith(
    'Check for a macOS prompt',
    expect.objectContaining({
      description:
        'If prompted, choose Allow. If no prompt appears, open System Settings and enable Orca under Privacy & Security → Local Network.',
      action: expect.objectContaining({ label: 'Open System Settings' })
    })
  )

  const options = toastMessageMock.mock.calls[0]?.[1] as { action?: { onClick?: () => void } }
  options.action?.onClick?.()
  expect(api.openSettings).toHaveBeenCalledWith({ id: 'local-network' })

  await act(async () => settingsButton?.click())
  expect(api.openSettings).toHaveBeenCalledTimes(2)
})

it('highlights the Full Disk Access row for a targeted Settings navigation', async () => {
  await act(async () => {
    root.render(
      <DeveloperPermissionsPane highlightedSettingId={FULL_DISK_ACCESS_SETTINGS_TARGET_ID} />
    )
  })

  const row = container.querySelector<HTMLElement>(
    `[data-settings-section="${FULL_DISK_ACCESS_SETTINGS_TARGET_ID}"]`
  )
  expect(row?.dataset.highlighted).toBe('true')
  expect(row?.className).toContain('data-[highlighted=true]:bg-accent')
  expect(row?.className).toContain('data-[highlighted=true]:ring-ring/50')

  await act(async () => root.render(<DeveloperPermissionsPane />))
  expect(row?.dataset.highlighted).toBeUndefined()
})

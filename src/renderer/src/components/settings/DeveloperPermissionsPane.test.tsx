// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { DeveloperPermissionState } from '../../../../shared/developer-permissions-types'
import { FULL_DISK_ACCESS_SETTINGS_TARGET_ID } from '@/lib/settings-navigation-types'
import { DeveloperPermissionsPane } from './DeveloperPermissionsPane'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  Object.assign(window, {
    api: {
      developerPermissions: {
        getStatus: vi.fn(
          async (): Promise<DeveloperPermissionState[]> => [
            { id: 'full-disk-access', status: 'denied' }
          ]
        ),
        request: vi.fn()
      }
    }
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  Reflect.deleteProperty(window, 'api')
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

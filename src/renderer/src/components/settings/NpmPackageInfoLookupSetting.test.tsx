// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: { settingsSearchQuery: string }) => unknown) =>
    selector({ settingsSearchQuery: '' })
}))

import { NpmPackageInfoLookupSetting } from './NpmPackageInfoLookupSetting'

let root: Root | null = null
let container: HTMLDivElement | null = null

afterEach(() => {
  if (root) {
    act(() => root?.unmount())
  }
  container?.remove()
  root = null
  container = null
})

function renderSetting(
  npmPackageInfoOnlineLookupsEnabled: boolean | undefined,
  updateSettings = vi.fn()
) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root?.render(
      <NpmPackageInfoLookupSetting
        settings={{ npmPackageInfoOnlineLookupsEnabled }}
        updateSettings={updateSettings}
      />
    )
  })
  return { container, updateSettings }
}

describe('NpmPackageInfoLookupSetting', () => {
  it('defaults to enabled for profiles saved before the preference existed', () => {
    const { container } = renderSetting(undefined)
    const toggle = container.querySelector('[role="switch"]')

    expect(toggle?.getAttribute('aria-checked')).toBe('true')
  })

  it('shows the toggle as off when the preference is explicitly disabled', () => {
    const { container } = renderSetting(false)
    const toggle = container.querySelector('[role="switch"]')

    expect(toggle?.getAttribute('aria-checked')).toBe('false')
  })

  it('persists disabling online lookups', () => {
    const updateSettings = vi.fn()
    const { container } = renderSetting(true, updateSettings)
    const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]')

    act(() => toggle?.click())

    expect(updateSettings).toHaveBeenCalledWith({ npmPackageInfoOnlineLookupsEnabled: false })
  })

  it('persists re-enabling online lookups', () => {
    const updateSettings = vi.fn()
    const { container } = renderSetting(false, updateSettings)
    const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]')

    act(() => toggle?.click())

    expect(updateSettings).toHaveBeenCalledWith({ npmPackageInfoOnlineLookupsEnabled: true })
  })
})

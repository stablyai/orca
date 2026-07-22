// @vitest-environment happy-dom

import { act, createElement, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  shouldShowMobileSidebarOnboardingBadge,
  useMobileSidebarOnboardingBadge
} from './mobile-sidebar-onboarding-badge'
import {
  _resetPairedMobileDevicesCacheForTests,
  replacePairedMobileDevices
} from '../mobile/paired-mobile-devices'

type HookState = ReturnType<typeof useMobileSidebarOnboardingBadge>

let latestHookState: HookState | null = null

function HookProbe({ enabled = true }: { enabled?: boolean }): null {
  latestHookState = useMobileSidebarOnboardingBadge(enabled)
  return null
}

const mountedRoots: Root[] = []
const listDevices = vi.fn()

async function renderHookProbe(props: ComponentProps<typeof HookProbe> = {}): Promise<void> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mountedRoots.push(root)
  await act(async () => {
    root.render(createElement(HookProbe, props))
  })
}

describe('mobile sidebar onboarding badge', () => {
  beforeEach(() => {
    vi.useRealTimers()
    latestHookState = null
    listDevices.mockReset()
    _resetPairedMobileDevicesCacheForTests()
    window.localStorage.clear()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        mobile: {
          listDevices
        }
      }
    })
  })

  afterEach(async () => {
    await act(async () => {
      for (const root of mountedRoots.splice(0)) {
        root.unmount()
      }
    })
    document.body.innerHTML = ''
    vi.useRealTimers()
  })

  it('does not show when the sidebar button is hidden', () => {
    expect(shouldShowMobileSidebarOnboardingBadge(false, false)).toBe(false)
  })

  it('shows only while enabled and undismissed', () => {
    expect(shouldShowMobileSidebarOnboardingBadge(true, false)).toBe(true)
    expect(shouldShowMobileSidebarOnboardingBadge(true, true)).toBe(false)
  })

  it('marks a paired device after shared mobile devices load', async () => {
    listDevices.mockResolvedValue({
      devices: [{ deviceId: 'phone-1', name: 'Phone', pairedAt: 1, lastSeenAt: 2 }]
    })

    await renderHookProbe()

    await vi.waitFor(() => expect(latestHookState?.hasPairedDevice).toBe(true))
    expect(latestHookState?.visible).toBe(false)
  })

  it('shows the badge after shared mobile devices load empty', async () => {
    replacePairedMobileDevices([])

    await renderHookProbe()

    expect(latestHookState?.visible).toBe(true)
    expect(latestHookState?.hasPairedDevice).toBe(false)
  })

  it('does not show the badge on a failed load and recovers on window focus', async () => {
    listDevices.mockRejectedValueOnce(new Error('startup race')).mockResolvedValueOnce({
      devices: [{ deviceId: 'phone-1', name: 'Phone', pairedAt: 1, lastSeenAt: 2 }]
    })

    await renderHookProbe()

    // Failed initial load: loaded flips true but the error flag suppresses the
    // onboarding badge so it can't masquerade as "no devices paired".
    await vi.waitFor(() => expect(listDevices).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(latestHookState?.visible).toBe(false))
    expect(latestHookState?.hasPairedDevice).toBe(false)

    // Regaining focus re-fetches and un-wedges the persistent sidebar consumer.
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })

    await vi.waitFor(() => expect(latestHookState?.hasPairedDevice).toBe(true))
  })
})

// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import type { ReactNode } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      settings: { showMobileButton: true },
      updateSettings: vi.fn()
    })
}))

vi.mock('./SearchableSetting', () => ({
  SearchableSetting: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('./SettingsFormControls', () => ({
  SettingsSwitchRow: () => null
}))

vi.mock('./MobilePane', () => ({
  MobilePane: () => null
}))

vi.mock('./MobileRelayBetaNotice', () => ({
  MobileRelayBetaNotice: () => null
}))

vi.mock('./mobile-settings-search', () => ({
  getMobileOverviewSearchEntry: () => ({ keywords: [] }),
  getMobileSidebarShortcutSearchEntry: () => ({ keywords: [] }),
  getMobileSettingsPaneSearchEntries: () => []
}))

import { MobileSettingsPane } from './MobileSettingsPane'

describe('MobileSettingsPane', () => {
  afterEach(cleanup)

  it('offers a desktop-transfer fallback when the Android download stalls (#11444)', () => {
    render(<MobileSettingsPane />)

    expect(
      screen.getByText(
        'If the APK download stalls near 99% on the phone, download it on a computer and transfer the file (USB cable / cloud storage / messaging), then install from the phone storage.'
      )
    ).toBeInTheDocument()
  })
})

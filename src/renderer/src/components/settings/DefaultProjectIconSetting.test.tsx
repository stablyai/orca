// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { DefaultProjectIconSetting } from './DefaultProjectIconSetting'

const tabsProps = vi.fn()
const colorProps = vi.fn()

vi.mock('./RepositoryIconTabs', () => ({
  RepositoryIconTabs: (props: Record<string, unknown>) => {
    tabsProps(props)
    return null
  }
}))

vi.mock('./RepositoryIconColorSection', () => ({
  RepositoryIconColorSection: (props: Record<string, unknown>) => {
    colorProps(props)
    return <div data-testid="color-section" />
  }
}))

function renderSetting(settings: Partial<GlobalSettings>): {
  updateSettings: ReturnType<typeof vi.fn>
} {
  const updateSettings = vi.fn()
  render(
    <DefaultProjectIconSetting
      settings={{ ...getDefaultSettings('/tmp'), ...settings }}
      updateSettings={updateSettings}
    />
  )
  return { updateSettings }
}

afterEach(() => {
  cleanup()
  tabsProps.mockReset()
  colorProps.mockReset()
})

describe('DefaultProjectIconSetting', () => {
  it('starts on the Avatar tab and reports that projects keep the owner avatar', () => {
    renderSetting({})

    expect(tabsProps).toHaveBeenCalledWith(expect.objectContaining({ initialTab: 'avatar' }))
    expect(screen.getByText('GitHub owner avatar')).toBeTruthy()
  })

  it('stores the icon chosen in the picker as the global default', () => {
    const { updateSettings } = renderSetting({})

    const { onSetIcon } = tabsProps.mock.calls[0][0]
    onSetIcon({ type: 'lucide', name: 'Folder' })

    expect(updateSettings).toHaveBeenCalledWith({
      defaultProjectIcon: { type: 'lucide', name: 'Folder' }
    })
  })

  it('treats the Avatar tab as "no default" rather than fetching one', () => {
    const { updateSettings } = renderSetting({
      defaultProjectIcon: { type: 'lucide', name: 'Folder' }
    })

    const { onUseGitHubAvatar, loadingGitHub } = tabsProps.mock.calls[0][0]
    onUseGitHubAvatar()

    expect(loadingGitHub).toBe(false)
    expect(updateSettings).toHaveBeenCalledWith({ defaultProjectIcon: null })
  })

  it('offers the color row only for an icon the color can tint', () => {
    renderSetting({ defaultProjectIcon: { type: 'lucide', name: 'Folder' } })
    expect(screen.queryByTestId('color-section')).not.toBeNull()

    cleanup()
    renderSetting({ defaultProjectIcon: { type: 'emoji', emoji: '🐳' } })
    expect(screen.queryByTestId('color-section')).toBeNull()
  })

  it('can restore each project badge color after choosing a global color', () => {
    const { updateSettings } = renderSetting({
      defaultProjectIcon: { type: 'lucide', name: 'Folder' },
      defaultProjectIconColor: '#e11d48'
    })

    const { onBadgeColorReset } = colorProps.mock.calls[0][0]
    onBadgeColorReset()

    expect(updateSettings).toHaveBeenCalledWith({ defaultProjectIconColor: undefined })
  })
})

// @vitest-environment happy-dom
import { isValidElement, type ReactElement } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { InstalledBrowser } from '../../../../shared/external-browser-types'
import { Select } from '../ui/select'
import { BrowserLinkRoutingSetting } from './BrowserLinkRoutingSetting'

const BROWSERS: InstalledBrowser[] = [
  { id: 'com.google.Chrome', name: 'Google Chrome' },
  { id: 'com.microsoft.edgemac', name: 'Microsoft Edge' }
]

type SelectElement = ReactElement<{ children?: unknown; onValueChange?: (value: string) => void }>

function findSelect(node: unknown): SelectElement {
  const stack = [node]
  while (stack.length > 0) {
    const current = stack.pop()
    if (Array.isArray(current)) {
      stack.push(...current)
    } else if (isValidElement<SelectElement['props']>(current)) {
      if (current.type === Select) {
        return current
      }
      stack.push(current.props.children)
    }
  }
  throw new Error('link destination select not found')
}

function settingsWith(overrides: Partial<GlobalSettings>): GlobalSettings {
  return { ...getDefaultSettings('/tmp'), ...overrides }
}

function props(
  settings: GlobalSettings,
  installedBrowsers: InstalledBrowser[] | null = BROWSERS,
  updateSettings = vi.fn()
): React.ComponentProps<typeof BrowserLinkRoutingSetting> {
  return {
    settings,
    installedBrowsers,
    linkRoutingDescription: 'Where links open.',
    isMac: true,
    updateSettings
  }
}

afterEach(cleanup)

describe('BrowserLinkRoutingSetting', () => {
  it.each([
    [
      'browser:com.microsoft.edgemac',
      { openLinksInApp: false, externalBrowserId: 'com.microsoft.edgemac' }
    ],
    ['orca', { openLinksInApp: true, externalBrowserId: null }],
    ['system', { openLinksInApp: false, externalBrowserId: null }]
  ])('selecting %s writes both link settings', (value, expected) => {
    const updateSettings = vi.fn()
    const select = findSelect(
      BrowserLinkRoutingSetting(
        props(settingsWith({ externalBrowserId: 'com.google.Chrome' }), BROWSERS, updateSettings)
      )
    )

    select.props.onValueChange?.(value)

    expect(updateSettings).toHaveBeenCalledWith({
      ...expected,
      openLinksInAppPreferencePrompted: true
    })
  })

  it.each([
    ['Orca Browser', { openLinksInApp: true }],
    ['System default browser', { openLinksInApp: false }],
    ['Microsoft Edge', { openLinksInApp: false, externalBrowserId: 'com.microsoft.edgemac' }]
  ])('shows %s for the stored settings', (label, overrides) => {
    render(<BrowserLinkRoutingSetting {...props(settingsWith(overrides))} />)

    expect(screen.getByRole('combobox').textContent).toContain(label)
  })

  it('is disabled while the browser list loads', () => {
    render(
      <BrowserLinkRoutingSetting
        {...props(settingsWith({ externalBrowserId: 'com.microsoft.edgemac' }), null)}
      />
    )

    const trigger = screen.getByRole('combobox')
    expect(trigger.hasAttribute('disabled')).toBe(true)
    expect(trigger.textContent).toContain('Loading browsers')
  })

  it('labels a configured browser that is no longer installed', () => {
    render(
      <BrowserLinkRoutingSetting
        {...props(settingsWith({ externalBrowserId: 'org.mozilla.firefox' }))}
      />
    )

    const trigger = screen.getByRole('combobox')
    expect(trigger.hasAttribute('disabled')).toBe(false)
    expect(trigger.textContent).toContain('Unavailable browser (using system default)')
  })
})

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { BrowserSitePermissionRule, GlobalSettings } from '../../../../shared/types'
import { useAppStore } from '../../store'
import {
  BrowserPermissionsPane,
  getBrowserPermissionRuleProfileLabel,
  removeBrowserSitePermissionRuleAtIndex
} from './BrowserPermissionsPane'

describe('BrowserPermissionsPane', () => {
  it('renders remembered rules with the owning browser profile', () => {
    useAppStore.setState({
      settingsSearchQuery: '',
      browserSessionProfiles: [
        {
          id: 'profile-1',
          scope: 'isolated',
          partition: 'persist:orca-browser-session-00000000-0000-0000-0000-000000000001',
          label: 'Testing profile',
          source: null
        }
      ]
    })

    const settings: GlobalSettings = {
      ...getDefaultSettings('/tmp'),
      browserSitePermissionRules: [
        {
          profileId: 'profile-1',
          origin: 'https://example.com',
          permission: 'notifications',
          action: 'allow'
        }
      ]
    }

    const markup = renderToStaticMarkup(
      <BrowserPermissionsPane settings={settings} updateSettings={() => undefined} />
    )

    expect(markup).toContain('https://example.com')
    expect(markup).toContain('notifications - Allow')
  })

  it('labels remembered rules with their browser profile when available', () => {
    const labels = new Map([['profile-1', 'Testing profile']])

    expect(getBrowserPermissionRuleProfileLabel('profile-1', labels)).toBe('Testing profile')
    expect(getBrowserPermissionRuleProfileLabel('missing', labels)).toBe('Removed profile missing')
  })

  it('removes a single remembered rule without disturbing the others', () => {
    const rules: BrowserSitePermissionRule[] = [
      {
        profileId: 'default',
        origin: 'https://one.example',
        permission: 'notifications',
        action: 'allow'
      },
      {
        profileId: 'profile-2',
        origin: 'https://two.example',
        permission: 'media',
        action: 'deny'
      }
    ]

    expect(removeBrowserSitePermissionRuleAtIndex(rules, 0)).toEqual([rules[1]])
  })
})

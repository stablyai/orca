import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { InstalledBrowser } from '../../../shared/external-browser-types'

type StoreState = {
  settings: { externalBrowserId?: string | null } | null
  installedBrowsers: InstalledBrowser[] | null
}
const storeState = vi.hoisted((): StoreState => ({ settings: null, installedBrowsers: null }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => storeState } }))

import {
  buildHttpLinkActions,
  httpLinkActionDestinationsFor,
  httpLinkDestinationLabel,
  httpLinkDirectClickDestination
} from './http-link-destinations'

beforeEach(() => {
  storeState.settings = null
  storeState.installedBrowsers = null
})

describe('httpLinkActionDestinationsFor', () => {
  it.each([
    ['local', { kind: 'local' } as const, false],
    ['capable runtime', { kind: 'runtime', runtimeEnvironmentId: 'env-1' } as const, true],
    ['eligible SSH', { kind: 'ssh', connectionId: 'ssh-1' } as const, true]
  ])(
    'offers both destinations for a %s owner and follows the preference',
    (_label, owner, canOpen) => {
      expect(httpLinkActionDestinationsFor({ openLinksInApp: true }, owner, canOpen)).toEqual({
        primary: 'orca',
        alternate: 'system'
      })
      expect(httpLinkActionDestinationsFor({ openLinksInApp: false }, owner, canOpen)).toEqual({
        primary: 'system',
        alternate: 'orca'
      })
    }
  )

  it.each([
    ['incapable runtime', { kind: 'runtime', runtimeEnvironmentId: 'env-1' } as const],
    ['ineligible SSH', { kind: 'ssh', connectionId: 'ssh-1' } as const],
    ['unknown owner', { kind: 'unknown' } as const]
  ])('offers only the system browser for an %s', (_label, owner) => {
    expect(httpLinkActionDestinationsFor({ openLinksInApp: true }, owner, false)).toEqual({
      primary: 'system'
    })
  })
})

describe('buildHttpLinkActions', () => {
  it('labels each offered destination and routes the run to it', () => {
    const opened: (string | undefined)[] = []
    const actions = buildHttpLinkActions(
      { primary: 'orca', alternate: 'system' },
      (destination) => {
        opened.push(destination)
      }
    )

    expect(actions.primary.label).toBe('Orca Browser')
    expect(actions.primary.external).toBe(false)
    expect(actions.alternate?.label).toBe('System Browser')
    expect(actions.alternate?.external).toBe(true)

    void actions.primary.run()
    void actions.alternate?.run()
    expect(opened).toEqual(['orca', 'system'])
  })

  it('omits the alternate row when only one destination is offered', () => {
    const actions = buildHttpLinkActions({ primary: 'system' }, () => {})
    expect(actions.alternate).toBeUndefined()
  })

  it('falls back to a generic label when no destination is known', () => {
    const opened: (string | undefined)[] = []
    const actions = buildHttpLinkActions(undefined, (destination) => {
      opened.push(destination)
    })
    expect(actions.primary.label).toBe('Open link')
    expect(actions.alternate).toBeUndefined()
    void actions.primary.run()
    expect(opened).toEqual([undefined])
  })
})

describe('external destination label', () => {
  beforeEach(() => {
    storeState.installedBrowsers = [
      { id: 'com.google.Chrome', name: 'Google Chrome' },
      { id: 'com.microsoft.edgemac', name: 'Microsoft Edge' }
    ]
  })

  it('names the configured browser instead of System Browser', () => {
    storeState.settings = { externalBrowserId: 'com.microsoft.edgemac' }

    expect(httpLinkDestinationLabel('system')).toBe('Microsoft Edge')
    expect(httpLinkDestinationLabel('orca')).toBe('Orca Browser')
  })

  it('falls back to System Browser when the configured browser is not installed', () => {
    storeState.settings = { externalBrowserId: 'org.mozilla.firefox' }

    expect(httpLinkDestinationLabel('system')).toBe('System Browser')
  })

  it('keeps Shift swapping Orca and the configured browser', () => {
    const settings = { openLinksInApp: false, externalBrowserId: 'com.microsoft.edgemac' }
    storeState.settings = settings
    const destinations = httpLinkActionDestinationsFor(settings, { kind: 'local' }, false)

    expect(httpLinkDirectClickDestination(destinations, false)).toBe('system')
    expect(httpLinkDirectClickDestination(destinations, true)).toBe('orca')
    const actions = buildHttpLinkActions(destinations, () => {})
    expect(actions.primary.label).toBe('Microsoft Edge')
    expect(actions.alternate?.label).toBe('Orca Browser')
  })
})

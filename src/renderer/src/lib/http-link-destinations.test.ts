import { afterEach, describe, expect, it } from 'vitest'
import type { NormalizedLinkRoute } from '../../../shared/plugins/plugin-link-route-matching'
import { usePluginLinkRouteStore } from '../store/plugin-link-routes'
import { buildHttpLinkActions, httpLinkActionDestinationsFor } from './http-link-destinations'

const UNROUTED_URL = 'https://unrouted.example.test/'

function setRoutes(routes: NormalizedLinkRoute[]): void {
  usePluginLinkRouteStore.setState({ routes })
}

describe('httpLinkActionDestinationsFor', () => {
  afterEach(() => {
    setRoutes([])
  })

  it.each([
    ['local', { kind: 'local' } as const, false],
    ['capable runtime', { kind: 'runtime', runtimeEnvironmentId: 'env-1' } as const, true],
    ['eligible SSH', { kind: 'ssh', connectionId: 'ssh-1' } as const, true]
  ])(
    'offers both destinations for a %s owner and follows the preference',
    (_label, owner, canOpen) => {
      expect(
        httpLinkActionDestinationsFor({ openLinksInApp: true }, owner, canOpen, UNROUTED_URL)
      ).toEqual({
        primary: 'orca',
        alternate: 'system'
      })
      expect(
        httpLinkActionDestinationsFor({ openLinksInApp: false }, owner, canOpen, UNROUTED_URL)
      ).toEqual({
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
    expect(
      httpLinkActionDestinationsFor({ openLinksInApp: true }, owner, false, UNROUTED_URL)
    ).toEqual({
      primary: 'system'
    })
  })

  const orcaRoute: NormalizedLinkRoute = {
    pattern: { kind: 'exact', host: 'routed.example.com' },
    destination: 'orca-browser',
    pluginKey: 'plugin-a',
    index: 0
  }
  const systemRoute: NormalizedLinkRoute = {
    pattern: { kind: 'label', tail: 'docs.example.com' },
    destination: 'system-browser',
    pluginKey: 'plugin-b',
    index: 0
  }

  it('lets an orca-browser route override the preference and keeps system as the alternate', () => {
    setRoutes([orcaRoute])
    expect(
      httpLinkActionDestinationsFor(
        { openLinksInApp: false },
        { kind: 'local' },
        false,
        'https://routed.example.com/a'
      )
    ).toEqual({ primary: 'orca', alternate: 'system' })
  })

  it('lets a system-browser route override the preference and keeps orca as the alternate', () => {
    setRoutes([systemRoute])
    expect(
      httpLinkActionDestinationsFor(
        { openLinksInApp: true },
        { kind: 'local' },
        false,
        'https://api.docs.example.com/a'
      )
    ).toEqual({ primary: 'system', alternate: 'orca' })
  })

  it('ignores a matching route when the source owner cannot reach the Orca browser', () => {
    setRoutes([orcaRoute])
    expect(
      httpLinkActionDestinationsFor(
        { openLinksInApp: true },
        { kind: 'ssh', connectionId: 'ssh-1' },
        false,
        'https://routed.example.com/a'
      )
    ).toEqual({ primary: 'system' })
  })

  it('behaves exactly as before while the route table is still empty', () => {
    setRoutes([])
    expect(
      httpLinkActionDestinationsFor(
        { openLinksInApp: true },
        { kind: 'local' },
        false,
        'https://routed.example.com/a'
      )
    ).toEqual({ primary: 'orca', alternate: 'system' })
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
    const actions = buildHttpLinkActions(undefined, () => {})
    expect(actions.primary.label).toBe('Open link')
    expect(actions.alternate).toBeUndefined()
  })
})

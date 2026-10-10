import { describe, expect, it } from 'vitest'
import { buildHttpLinkActions, httpLinkActionDestinationsFor } from './http-link-destinations'

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
    const actions = buildHttpLinkActions(undefined, () => {})
    expect(actions.primary.label).toBe('Open link')
    expect(actions.alternate).toBeUndefined()
  })
})

import { describe, expect, it } from 'vitest'
import {
  MAC_UPDATE_INSTALL_MARKER_MAX_AGE_MS,
  createAttemptId,
  decideMacUpdateLaunch,
  isAttemptInFlight,
  getMacUpdateInstallMarkerDir,
  getMacUpdateInstallMarkerPath,
  parseMacUpdateInstallMarker,
  selectActiveMarker,
  selectInFlightMarker,
  type MacUpdateInstallMarker
} from './mac-update-install-marker'

const BUNDLE = '/Applications/Orca.app'
const NOW = 1_700_000_000_000

const marker = (overrides: Partial<MacUpdateInstallMarker> = {}): MacUpdateInstallMarker => ({
  schemaVersion: 1,
  bundlePath: BUNDLE,
  fromVersion: '1.4.194',
  targetVersion: '1.4.195',
  requestedByPid: 4242,
  requestedByStartedAtMs: NOW - 60_000,
  attemptId: 'a1b2c3d4e5f60718',
  createdAtMs: NOW - 5_000,
  ...overrides
})

describe('marker paths', () => {
  it('keys markers by bundle path, not by userData', () => {
    const a = getMacUpdateInstallMarkerDir('/Applications/Orca.app')
    const b = getMacUpdateInstallMarkerDir('/Applications/Orca-adhoc.app')
    expect(a).not.toBe(b)
    // Same bundle from any profile or serve instance must resolve to the same directory.
    expect(getMacUpdateInstallMarkerDir('/Applications/Orca.app')).toBe(a)
  })

  it('gives each attempt its own file so an owner can never delete a newer one', () => {
    // This is what makes deletion safe: compare-then-unlink was a race, distinct names are not.
    const mine = getMacUpdateInstallMarkerPath(BUNDLE, marker())
    const newer = getMacUpdateInstallMarkerPath(BUNDLE, marker({ createdAtMs: NOW + 1_000 }))
    const otherProcess = getMacUpdateInstallMarkerPath(BUNDLE, marker({ requestedByPid: 777 }))
    expect(new Set([mine, newer, otherProcess]).size).toBe(3)
  })

  it('separates two attempts made in the same millisecond by the same process', () => {
    // Timestamp+pid alone collide on a rapid retry, and the loser could then be unlinked by the
    // winner's owner — which is exactly the race per-attempt filenames exist to remove.
    const first = getMacUpdateInstallMarkerPath(BUNDLE, marker({ attemptId: '00000000000000aa' }))
    const second = getMacUpdateInstallMarkerPath(BUNDLE, marker({ attemptId: '00000000000000bb' }))
    expect(first).not.toBe(second)
  })

  it('mints a distinct attempt id each time', () => {
    expect(createAttemptId()).not.toBe(createAttemptId())
    expect(createAttemptId()).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('selectActiveMarker', () => {
  it('picks the newest attempt when several are in flight', () => {
    const older = marker({ createdAtMs: NOW - 10_000 })
    const newest = marker({ createdAtMs: NOW })
    expect(selectActiveMarker([older, newest, marker({ createdAtMs: NOW - 5_000 })], NOW)).toEqual(
      newest
    )
  })

  it('ignores a dead newest attempt so an older live one still governs', () => {
    // Otherwise the gate waits for a version nobody is installing while the real install runs.
    const expired = marker({
      createdAtMs: NOW - MAC_UPDATE_INSTALL_MARKER_MAX_AGE_MS - 1,
      targetVersion: '9.9.9'
    })
    const live = marker({ createdAtMs: NOW - 5_000 })
    expect(selectActiveMarker([expired, live], NOW)).toEqual(live)
  })

  it('reports nothing when every attempt has expired', () => {
    const expired = marker({ createdAtMs: NOW - MAC_UPDATE_INSTALL_MARKER_MAX_AGE_MS - 1 })
    expect(selectActiveMarker([expired], NOW)).toBeNull()
  })

  it('reports nothing when no attempt is recorded', () => {
    expect(selectActiveMarker([], NOW)).toBeNull()
  })
})

describe('selectInFlightMarker', () => {
  it('skips a newer dead attempt so an older live writer still governs', () => {
    const older = marker({
      createdAtMs: NOW,
      requestedByPid: 11,
      attemptId: 'ffffffffffffffff'
    })
    const newer = marker({
      createdAtMs: NOW,
      requestedByPid: 22,
      attemptId: '0000000000000000'
    })
    expect(
      selectInFlightMarker([newer, older], NOW, (candidate) => candidate.requestedByPid === 11)
    ).toEqual(older)
  })

  it('still prefers the newest among live attempts', () => {
    const older = marker({ createdAtMs: NOW - 1_000, attemptId: '0000000000000001' })
    const newer = marker({ createdAtMs: NOW, attemptId: '0000000000000002' })
    expect(selectInFlightMarker([older, newer], NOW, () => true)).toEqual(newer)
  })
})

describe('parseMacUpdateInstallMarker', () => {
  it('accepts a well-formed marker', () => {
    expect(parseMacUpdateInstallMarker(marker())).toEqual(marker())
  })

  it('accepts the prerelease version shapes Orca actually ships', () => {
    const shipped = marker({ targetVersion: '1.4.195-hourly.202609012014' })
    expect(parseMacUpdateInstallMarker(shipped)).toEqual(shipped)
  })

  it.each([
    ['wrong schema', { ...marker(), schemaVersion: 2 }],
    ['missing bundle path', { ...marker(), bundlePath: '' }],
    ['missing target version', { ...marker(), targetVersion: '' }],
    ['non-integer pid', { ...marker(), requestedByPid: 1.5 }],
    ['zero pid', { ...marker(), requestedByPid: 0 }],
    ['invalid process start', { ...marker(), requestedByStartedAtMs: 0 }],
    ['no timestamp', { ...marker(), createdAtMs: 0 }],
    ['non-integer timestamp', { ...marker(), createdAtMs: 1.5 }],
    ['empty from version', { ...marker(), fromVersion: '' }],
    ['whitespace target version', { ...marker(), targetVersion: '   ' }],
    ['whitespace from version', { ...marker(), fromVersion: ' ' }],
    ['relative bundle path', { ...marker(), bundlePath: 'Orca.app' }],
    ['bundle path that is not an app', { ...marker(), bundlePath: '/Applications/Orca' }],
    ['padded target version', { ...marker(), targetVersion: ' 1.4.195 ' }],
    ['non-version target string', { ...marker(), targetVersion: 'garbage' }],
    ['digit-prefixed junk', { ...marker(), targetVersion: '1garbage' }],
    ['digit-prefixed junk in from version', { ...marker(), fromVersion: '9nonsense' }],
    ['missing attempt id', { ...marker(), attemptId: '' }],
    ['malformed attempt id', { ...marker(), attemptId: 'not-hex' }],
    [
      'old-format marker with no attemptId property at all',
      (() => {
        const { attemptId: _omitted, ...withoutAttemptId } = marker()
        return withoutAttemptId
      })()
    ],
    ['not an object', 'nope'],
    ['null', null]
  ])('rejects %s', (_label, value) => {
    expect(parseMacUpdateInstallMarker(value)).toBeNull()
  })

  it('accepts an old marker without process identity so mixed installed versions fail open', () => {
    const { requestedByStartedAtMs: _omitted, ...oldMarker } = marker()
    expect(parseMacUpdateInstallMarker(oldMarker)).toEqual(oldMarker)
  })

  it('accepts a kernel start time beyond wall-clock creation after a backwards clock step', () => {
    const skewed = marker({ requestedByStartedAtMs: marker().createdAtMs + 60_000 })
    expect(parseMacUpdateInstallMarker(skewed)).toEqual(skewed)
  })
})

describe('decideMacUpdateLaunch', () => {
  const decide = (
    m: MacUpdateInstallMarker | null,
    bundleVersion: string | null = '1.4.194',
    now = NOW
  ) => decideMacUpdateLaunch({ marker: m, bundlePath: BUNDLE, bundleVersion, now })

  it('opens when no install is in flight', () => {
    expect(decide(null)).toBe('open')
  })

  it('waits while an install is in flight', () => {
    expect(decide(marker())).toBe('wait')
  })

  it('does not block on a marker for a different bundle', () => {
    expect(decide(marker({ bundlePath: '/Applications/Other.app' }))).toBe('clear-and-open')
  })

  it('opens once the swap has landed rather than launching a second instance', () => {
    // ShipIt relaunches the app itself, so "target version is live" must never mean "wait".
    expect(decide(marker(), '1.4.195')).toBe('clear-and-open')
  })

  it('expires a marker left behind by a crash instead of locking the user out', () => {
    const stale = marker({ createdAtMs: NOW - MAC_UPDATE_INSTALL_MARKER_MAX_AGE_MS - 1 })
    expect(decide(stale)).toBe('clear-and-open')
  })

  it('still waits at the longest observed ShipIt wait', () => {
    // A cap shorter than ShipIt's patience re-opens the exact race this gate exists to close.
    expect(decide(marker({ createdAtMs: NOW - 9 * 60_000 - 37_000 }))).toBe('wait')
  })

  it('treats a future-dated marker as corrupt rather than fresh forever', () => {
    expect(decide(marker({ createdAtMs: NOW + 10 * 60_000 }))).toBe('clear-and-open')
  })

  it('tolerates small clock skew without discarding a live install', () => {
    expect(decide(marker({ createdAtMs: NOW + 5_000 }))).toBe('wait')
  })

  it('waits when the bundle version cannot be read mid-swap', () => {
    // The bundle is being moved; an unreadable Info.plist means "still installing", not "gone".
    expect(decide(marker(), null)).toBe('wait')
  })
})

describe('isAttemptInFlight', () => {
  const inFlight = (over: Partial<Parameters<typeof isAttemptInFlight>[0]> = {}) =>
    isAttemptInFlight({
      marker: marker(),
      now: NOW,
      shipItLiveness: 'live',
      writerAlive: false,
      ...over
    })

  it('is in flight while the installer is running', () => {
    expect(inFlight()).toBe(true)
  })

  it('is in flight before the writer has exited, when the installer cannot have started yet', () => {
    // The writer's own exit is what lets ShipIt spawn, so a live writer means pre-spawn — not
    // absence. Reading 'exited' here would launch straight into the install.
    expect(inFlight({ writerAlive: true, shipItLiveness: 'exited' })).toBe(true)
  })

  it('is not in flight once the writer is gone and the installer is proven gone too', () => {
    expect(inFlight({ writerAlive: false, shipItLiveness: 'exited' })).toBe(false)
  })

  it('is NOT in flight when the installer cannot be verified', () => {
    expect(inFlight({ writerAlive: false, shipItLiveness: 'unverifiable' })).toBe(false)
  })

  it('is never in flight once the attempt has expired, whatever the phase says', () => {
    const stale = marker({ createdAtMs: NOW - MAC_UPDATE_INSTALL_MARKER_MAX_AGE_MS - 1 })
    expect(inFlight({ marker: stale, writerAlive: true, shipItLiveness: 'live' })).toBe(false)
  })

  it('is not in flight with no attempt recorded', () => {
    expect(inFlight({ marker: null })).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import {
  isStablePaneId,
  isTerminalLeafId,
  makePaneKey,
  makePaneSpawnReservationKey,
  type PaneSpawnReservationPathFlavor,
  parseLegacyNumericPaneKey,
  parsePaneKey
} from './stable-pane-id'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = makePaneKey('tab-1', LEAF_ID)

function reservationKey(
  workspaceId: string,
  scope: {
    connectionId?: string
    executionRuntime?: string
    pathFlavor?: PaneSpawnReservationPathFlavor
  } = {}
) {
  return makePaneSpawnReservationKey({
    paneKey: PANE_KEY,
    providerId: 'provider-1',
    workspaceId,
    sessionId: 'session-1',
    pathFlavor: 'posix',
    ...scope
  })
}

describe('stable pane ids', () => {
  it('recognizes UUID leaf ids as stable pane ids', () => {
    expect(isStablePaneId(LEAF_ID)).toBe(true)
    expect(isTerminalLeafId(LEAF_ID)).toBe(true)
  })

  it('rejects legacy numeric pane ids and malformed UUIDs', () => {
    for (const value of ['1', 'pane:1', '11111111-1111-6111-8111-111111111111', '']) {
      expect(isStablePaneId(value)).toBe(false)
      expect(isTerminalLeafId(value)).toBe(false)
    }
  })

  it('builds and parses pane keys using the tab id and UUID leaf id', () => {
    const paneKey = makePaneKey('tab-1', LEAF_ID)

    expect(paneKey).toBe(`tab-1:${LEAF_ID}`)
    expect(parsePaneKey(paneKey)).toEqual({
      tabId: 'tab-1',
      leafId: LEAF_ID,
      stablePaneId: LEAF_ID
    })
  })

  it('rejects ambiguous tab ids and non-UUID leaf ids when building keys', () => {
    expect(() => makePaneKey('', LEAF_ID)).toThrow(/tabId/)
    expect(() => makePaneKey('tab:1', LEAF_ID)).toThrow(/tabId/)
    expect(() => makePaneKey('tab-1', '1')).toThrow(/UUID/)
  })

  it('rejects ambiguous or legacy pane-key inputs when parsing', () => {
    expect(parsePaneKey('tab-1:1')).toBeNull()
    expect(parsePaneKey(`tab:1:${LEAF_ID}`)).toBeNull()
    expect(parsePaneKey(`:${LEAF_ID}`)).toBeNull()
    expect(parsePaneKey('tab-1:')).toBeNull()
  })

  it('parses legacy numeric pane keys only for migration aliases', () => {
    expect(parseLegacyNumericPaneKey(' tab-1:12 ')).toEqual({
      tabId: 'tab-1',
      numericPaneId: '12',
      paneKey: 'tab-1:12'
    })
    expect(parseLegacyNumericPaneKey(`tab-1:${LEAF_ID}`)).toBeNull()
    expect(parseLegacyNumericPaneKey('tab:1:12')).toBeNull()
  })

  it.each([
    ['local', { executionRuntime: 'native' }],
    ['SSH', { connectionId: 'ssh-1' }],
    ['unknown SSH', { connectionId: 'ssh-unknown', pathFlavor: 'unknown' as const }]
  ])('keeps NFC and NFD workspace paths distinct on %s', (_label, scope) => {
    expect(reservationKey('repo-1::/workspaces/café', scope)).not.toBe(
      reservationKey('repo-1::/workspaces/cafe\u0301', scope)
    )
  })

  it.each([
    ['POSIX', { executionRuntime: 'native', pathFlavor: 'posix' as const }],
    ['SSH POSIX', { connectionId: 'ssh-1', pathFlavor: 'posix' as const }],
    ['unknown remote', { connectionId: 'ssh-unknown', pathFlavor: 'unknown' as const }]
  ])('keeps leading-double-slash path case byte-exact on %s', (_label, scope) => {
    expect(reservationKey('repo-1:://Server/Share', scope)).not.toBe(
      reservationKey('repo-1:://server/share', scope)
    )
  })

  it.each([
    ['drive', 'repo-1::C:\\Work\\Project\\', 'repo-1::c:/work/project'],
    ['UNC', 'repo-1::\\\\Server\\Share\\Project\\', 'repo-1:://server/share/project'],
    [
      'WSL UNC',
      'repo-1::\\\\wsl.localhost\\Ubuntu\\home\\Project',
      'repo-1:://wsl$/ubuntu/home/Project'
    ]
  ])('canonicalizes equivalent Windows %s paths', (_label, left, right) => {
    expect(reservationKey(left, { pathFlavor: 'windows' })).toBe(
      reservationKey(right, { pathFlavor: 'windows' })
    )
  })

  it('fails safe for Windows-looking paths on an unknown host', () => {
    expect(reservationKey('repo-1::C:\\Work\\Project', { pathFlavor: 'unknown' })).not.toBe(
      reservationKey('repo-1::c:/work/project', { pathFlavor: 'unknown' })
    )
  })

  it('canonicalizes raw and worktree-scoped aliases', () => {
    expect(reservationKey('repo-1::/workspaces/project')).toBe(
      reservationKey('worktree:repo-1::/workspaces/project')
    )
  })

  it('does not collapse independent PTY scopes', () => {
    const base = {
      paneKey: PANE_KEY,
      providerId: 'provider-1',
      connectionId: 'ssh-1',
      executionRuntime: 'wsl:Ubuntu',
      pathFlavor: 'windows' as const,
      workspaceId: 'worktree:repo-1::/workspaces/project',
      sessionId: 'session-1',
      spawnPath: 'C:\\Workspaces\\Project',
      routeOrReconnectFreshness: 'route-1'
    }
    const canonical = makePaneSpawnReservationKey(base)

    for (const distinct of [
      { providerId: 'provider-2' },
      { connectionId: 'ssh-2' },
      { executionRuntime: 'native' },
      { workspaceId: 'repo-1::/workspaces/other' },
      { workspaceId: 'folder:repo-1::/workspaces/project' },
      { sessionId: 'session-2' },
      { spawnPath: 'C:\\Workspaces\\Other' },
      { routeOrReconnectFreshness: 'route-2' }
    ]) {
      expect(makePaneSpawnReservationKey({ ...base, ...distinct })).not.toBe(canonical)
    }
  })

  it('does not reserve an unscoped pane identity', () => {
    expect(
      makePaneSpawnReservationKey({
        paneKey: makePaneKey('tab-1', LEAF_ID),
        providerId: 'provider-1',
        pathFlavor: 'unknown'
      })
    ).toBeNull()
  })

  it('canonicalizes the final spawn path with execution-host semantics', () => {
    const base = {
      paneKey: PANE_KEY,
      providerId: 'provider-1',
      pathFlavor: 'windows' as const,
      workspaceId: 'folder:folder-1',
      spawnPath: '\\\\Server\\Share\\Project\\'
    }
    expect(makePaneSpawnReservationKey(base)).toBe(
      makePaneSpawnReservationKey({ ...base, spawnPath: '//server/share/project' })
    )
    expect(makePaneSpawnReservationKey({ ...base, pathFlavor: 'posix' })).not.toBe(
      makePaneSpawnReservationKey({
        ...base,
        pathFlavor: 'posix',
        spawnPath: '//server/share/project'
      })
    )
  })
})

import { expect, it } from 'vitest'
import { applyDesktopRelayWrite } from './desktop-relay-ownership'
import type { WorkspaceSessionState } from './workspace-session-state-types'

// Perf contract: a window write for a host it can't speak for in full (a partition holding parked
// workspaces) changes only the ids it sends, so main never walks that partition's stored relay ids.

it("reads none of an incomplete host's other stored relay ids", () => {
  let enumerations = 0
  const counted = (record: Record<string, string>) =>
    new Proxy(record, {
      ownKeys: (target) => {
        enumerations += 1
        return Reflect.ownKeys(target)
      }
    })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the apply reads only relay, owner and adoption fields.
  const session = {
    remoteSessionIdsByTabId: counted({
      'tab-b': 'relay-main',
      'tab-c': 'relay-c',
      'tab-d': 'relay-d'
    }),
    desktopRelayOwnerByTabId: counted({ 'tab-d': 'relay-d' }),
    desktopRelayAdoptionVersion: 1
  } as WorkspaceSessionState

  const result = applyDesktopRelayWrite(
    session,
    { relayIdsByTabId: { 'tab-b': 'relay-window' }, complete: false },
    null
  )

  expect(result).toEqual({ patch: null, refused: true, changedTabIds: [] })
  expect(enumerations).toBe(0)
})

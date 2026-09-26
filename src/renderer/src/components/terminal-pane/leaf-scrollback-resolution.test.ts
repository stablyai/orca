import { describe, expect, it } from 'vitest'
import { TERMINAL_SCROLLBACK_SESSION_HOMES } from '../../../../shared/workspace-session-terminal-buffers'
import {
  resolveLeafScrollbackBuffers,
  resolveTabScrollbackBuffers,
  type TerminalScrollbackSessionHomes
} from './leaf-scrollback-resolution'

// Why enumerated off the cap's constant: the invariant "no consumer reads a home directly" only
// holds while the resolver reads every home the session can persist. A third entry in
// TERMINAL_SCROLLBACK_SESSION_HOMES fails here (and the Pick type above) until the resolver reads it.
describe.each(TERMINAL_SCROLLBACK_SESSION_HOMES)('resolveTabScrollbackBuffers reads %s', (home) => {
  const sessionWithBytesOnlyIn: Record<
    (typeof TERMINAL_SCROLLBACK_SESSION_HOMES)[number],
    TerminalScrollbackSessionHomes
  > = {
    terminalLayoutsByTabId: {
      terminalLayoutsByTabId: {
        'tab-1': {
          root: null,
          activeLeafId: null,
          expandedLeafId: null,
          buffersByLeafId: { 'leaf-1': 'from-shared' }
        }
      },
      localOnlyScrollbackByTabId: {}
    },
    localOnlyScrollbackByTabId: {
      terminalLayoutsByTabId: {},
      localOnlyScrollbackByTabId: { 'tab-1': { 'leaf-1': 'from-local-only' } }
    }
  }

  it('returns the bytes that home holds for the tab', () => {
    expect(resolveTabScrollbackBuffers(sessionWithBytesOnlyIn[home], 'tab-1')).toEqual({
      'leaf-1': home === 'terminalLayoutsByTabId' ? 'from-shared' : 'from-local-only'
    })
    expect(resolveTabScrollbackBuffers(sessionWithBytesOnlyIn[home], 'tab-other')).toBeUndefined()
  })
})

describe('resolveLeafScrollbackBuffers', () => {
  it('returns the shared layout buffers when nothing is held locally', () => {
    const shared = { buffersByLeafId: { 'leaf-1': 'shared' } }
    expect(resolveLeafScrollbackBuffers({ shared, localOnly: undefined })).toBe(
      shared.buffersByLeafId
    )
    expect(resolveLeafScrollbackBuffers({ shared, localOnly: {} })).toBe(shared.buffersByLeafId)
  })

  it('returns the local-only buffers when the shared layout holds none', () => {
    const localOnly = { 'leaf-1': 'local' }
    expect(resolveLeafScrollbackBuffers({ shared: undefined, localOnly })).toBe(localOnly)
    expect(resolveLeafScrollbackBuffers({ shared: {}, localOnly })).toBe(localOnly)
  })

  it('lets the local-only copy win a leaf both homes hold, and unions the rest', () => {
    expect(
      resolveLeafScrollbackBuffers({
        shared: { buffersByLeafId: { 'leaf-1': 'shared-stale', 'leaf-2': 'shared-only' } },
        localOnly: { 'leaf-1': 'local-newer', 'leaf-3': 'local-only' }
      })
    ).toEqual({ 'leaf-1': 'local-newer', 'leaf-2': 'shared-only', 'leaf-3': 'local-only' })
  })

  it('returns undefined when neither home holds anything', () => {
    expect(
      resolveLeafScrollbackBuffers({ shared: undefined, localOnly: undefined })
    ).toBeUndefined()
  })
})

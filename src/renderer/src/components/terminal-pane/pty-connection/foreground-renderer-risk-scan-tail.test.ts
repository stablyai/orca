import { describe, expect, it } from 'vitest'
import { bindFreshSpawnFollowReset } from './fresh-spawn-follow-reset'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

/**
 * The foreground renderer-risk scan classifies the carried tail SPLICED onto the
 * incoming chunk, not the raw chunk. ConPTY splits a background SGR mid-sequence
 * routinely, and the continuation carries no escape of its own — so any cheap
 * pre-gate that inspects `data` instead of `scanData` silently drops the refresh
 * for exactly the redraws this path exists to catch.
 */
function buildSession(): ConnectPanePtySession {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the bag names every field the renderer-risk scan reads; the cast only supplies the rest of the session shape, which this suite never reaches.
  const session = {
    pane: { id: 'pane-1', terminal: {} },
    foregroundRefreshRiskScanTail: ''
  } as unknown as ConnectPanePtySession
  bindFreshSpawnFollowReset(session)
  return session
}

describe('foregroundRendererRiskOutputPrefersRenderRefresh', () => {
  it('refreshes a background SGR split across chunks', () => {
    const session = buildSession()

    expect(session.foregroundRendererRiskOutputPrefersRenderRefresh('\x1b[4')).toBe(false)
    expect(session.foregroundRefreshRiskScanTail).toBe('\x1b[4')

    expect(session.foregroundRendererRiskOutputPrefersRenderRefresh('1m x')).toBe(true)
    expect(session.foregroundRefreshRiskScanTail).toBe('')
  })

  it('carries a bare escape split before the CSI introducer', () => {
    const session = buildSession()

    expect(session.foregroundRendererRiskOutputPrefersRenderRefresh('\x1b')).toBe(false)
    expect(session.foregroundRefreshRiskScanTail).toBe('\x1b')

    expect(session.foregroundRendererRiskOutputPrefersRenderRefresh('[104m x')).toBe(true)
  })

  it('does not refresh the continuation chunk on its own', () => {
    // The discriminator for the splice: '1m x' is escape-free ASCII.
    expect(buildSession().foregroundRendererRiskOutputPrefersRenderRefresh('1m x')).toBe(false)
  })

  it('does not carry a completed sequence into the next chunk', () => {
    const session = buildSession()

    expect(session.foregroundRendererRiskOutputPrefersRenderRefresh('\x1b[32mplain green')).toBe(
      false
    )
    expect(session.foregroundRefreshRiskScanTail).toBe('')
  })

  it('keeps an empty chunk from dropping the pending tail', () => {
    const session = buildSession()

    session.foregroundRendererRiskOutputPrefersRenderRefresh('\x1b[4')
    expect(session.foregroundRendererRiskOutputPrefersRenderRefresh('')).toBe(false)
    expect(session.foregroundRefreshRiskScanTail).toBe('\x1b[4')
    expect(session.foregroundRendererRiskOutputPrefersRenderRefresh('8;5;33m x')).toBe(true)
  })
})

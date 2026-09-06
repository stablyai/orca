import { describe, expect, it, vi } from 'vitest'
import {
  CONPTY_DA1_RESPONSE,
  CONPTY_DA1_RESPONSE_WITHOUT_SIXEL,
  DEFAULT_DA1_RESPONSE,
  SIXEL_DA1_RESPONSE
} from '../terminal-capability-replies'
import { bindHiddenStartupRendererQueryWrite } from './hidden-startup-renderer-query-write'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

function createSalvageSession(options: {
  hasImageSupport?: boolean
  isNativeWindowsConpty?: boolean
}): {
  session: ConnectPanePtySession
  sendDesktopQueryReplyImmediate: ReturnType<typeof vi.fn>
} {
  const sendDesktopQueryReplyImmediate = vi.fn()
  const session = {
    pane: {
      hasImageSupport: options.hasImageSupport,
      terminal: {
        rows: 24,
        cols: 80,
        buffer: { active: { cursorY: 0, cursorX: 0 } }
      }
    },
    isNativeWindowsConpty: options.isNativeWindowsConpty === true,
    sendDesktopQueryReplyImmediate,
    writePtyOutputToXterm: vi.fn()
  } as unknown as ConnectPanePtySession
  bindHiddenStartupRendererQueryWrite(session)
  return { session, sendDesktopQueryReplyImmediate }
}

describe('hidden startup DA1 salvage', () => {
  it('omits sixel when the pane has no image handler', () => {
    const { session, sendDesktopQueryReplyImmediate } = createSalvageSession({})

    session.salvageRendererQueriesFromDiscardedRestoreData('\x1b[c')

    expect(sendDesktopQueryReplyImmediate).toHaveBeenCalledWith(DEFAULT_DA1_RESPONSE)
  })

  it('advertises sixel only when the image handler attached', () => {
    const { session, sendDesktopQueryReplyImmediate } = createSalvageSession({
      hasImageSupport: true
    })

    session.salvageRendererQueriesFromDiscardedRestoreData('\x1b[0c')

    expect(sendDesktopQueryReplyImmediate).toHaveBeenCalledWith(SIXEL_DA1_RESPONSE)
  })

  it('keeps the ConPTY sixel bit only when the image handler attached', () => {
    const withoutImage = createSalvageSession({ isNativeWindowsConpty: true })
    withoutImage.session.salvageRendererQueriesFromDiscardedRestoreData('\x1b[c')
    expect(withoutImage.sendDesktopQueryReplyImmediate).toHaveBeenCalledWith(
      CONPTY_DA1_RESPONSE_WITHOUT_SIXEL
    )

    const withImage = createSalvageSession({
      hasImageSupport: true,
      isNativeWindowsConpty: true
    })
    withImage.session.salvageRendererQueriesFromDiscardedRestoreData('\x1b[c')
    expect(withImage.sendDesktopQueryReplyImmediate).toHaveBeenCalledWith(CONPTY_DA1_RESPONSE)
  })
})

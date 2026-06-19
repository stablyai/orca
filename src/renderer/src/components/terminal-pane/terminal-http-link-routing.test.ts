import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getTerminalHttpBrowserTipCopy,
  getTerminalHttpRouteModeForEvent,
  getTerminalHttpUrlOpenHint
} from './terminal-http-link-routing'

function setPlatform(userAgent: string): void {
  vi.stubGlobal('navigator', { userAgent })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('terminal http link routing helpers', () => {
  it('builds hover copy for the system-browser default', () => {
    setPlatform('Macintosh')

    expect(
      getTerminalHttpUrlOpenHint({
        worktreeId: 'wt-1',
        openLinksInApp: false,
        connectionId: null
      })
    ).toBe('Click opens system browser; ⇧⌘-click opens in Orca once.')
  })

  it('does not promise alternate Orca routing before settings hydrate', () => {
    setPlatform('Macintosh')

    expect(getTerminalHttpUrlOpenHint({ worktreeId: 'wt-1', connectionId: null })).toBe(
      'Click opens system browser; Orca Browser routing is available after settings load.'
    )
  })

  it('does not promise Orca Browser routing before connection metadata resolves', () => {
    setPlatform('Macintosh')

    expect(
      getTerminalHttpUrlOpenHint({
        worktreeId: 'wt-1',
        openLinksInApp: false,
        connectionId: undefined
      })
    ).toBe('Click opens system browser; Orca Browser routing is available for local terminals.')
  })

  it('does not promise Orca Browser routing for unhydrated remote terminals', () => {
    setPlatform('Macintosh')

    expect(getTerminalHttpUrlOpenHint({ worktreeId: 'wt-1', connectionId: 'ssh-1' })).toBe(
      'Click opens system browser; Orca Browser routing is available for local terminals.'
    )
    expect(
      getTerminalHttpUrlOpenHint({
        worktreeId: 'wt-1',
        activeRuntimeEnvironmentId: 'runtime-1'
      })
    ).toBe('Click opens system browser; Orca Browser routing is available for local terminals.')
  })

  it('builds hover copy for the Orca Browser default', () => {
    setPlatform('Windows')

    expect(
      getTerminalHttpUrlOpenHint({
        worktreeId: 'wt-1',
        openLinksInApp: true,
        connectionId: null
      })
    ).toBe('Click opens in Orca; Shift+Ctrl-click opens system browser once.')
  })

  it('does not promise Orca Browser routing for SSH-backed terminals', () => {
    setPlatform('Macintosh')

    expect(
      getTerminalHttpUrlOpenHint({
        worktreeId: 'wt-1',
        openLinksInApp: true,
        connectionId: 'ssh-1'
      })
    ).toBe('Click opens system browser; Orca Browser routing is available for local terminals.')
    expect(
      getTerminalHttpBrowserTipCopy({
        worktreeId: 'wt-1',
        openLinksInApp: true,
        connectionId: 'ssh-1'
      })
    ).toEqual({
      title: 'Terminal links use your system browser here',
      description:
        'Orca Browser link routing is available for local terminal links in Settings -> Browser.'
    })
  })

  it('uses Cmd on macOS and Ctrl elsewhere for alternate routing', () => {
    setPlatform('Macintosh')
    expect(
      getTerminalHttpRouteModeForEvent({ shiftKey: true, metaKey: true, ctrlKey: false })
    ).toBe('alternate')
    expect(
      getTerminalHttpRouteModeForEvent({ shiftKey: true, metaKey: false, ctrlKey: true })
    ).toBe('force-system')

    setPlatform('Windows')
    expect(
      getTerminalHttpRouteModeForEvent({ shiftKey: true, metaKey: false, ctrlKey: true })
    ).toBe('alternate')
    expect(
      getTerminalHttpRouteModeForEvent({ shiftKey: true, metaKey: true, ctrlKey: false })
    ).toBe('force-system')
  })
})

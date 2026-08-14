import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { DaemonDegradedNotice } from './DaemonDegradedNotice'

function render(props: Partial<React.ComponentProps<typeof DaemonDegradedNotice>> = {}): string {
  return renderToStaticMarkup(
    React.createElement(DaemonDegradedNotice, {
      degraded: true,
      isBusy: false,
      onRestartDaemon: vi.fn(),
      ...props
    })
  )
}

describe('DaemonDegradedNotice', () => {
  it('renders nothing when the daemon is healthy', () => {
    // The common case by far; a notice that shows up here would train the user to ignore it.
    expect(render({ degraded: false })).toBe('')
  })

  it('warns that new terminals will not survive quitting', () => {
    // The consequence the user actually needs, not the mechanism. Degraded mode's real cost is
    // that a terminal opened now disappears on quit, and nothing else in the app says so.
    const html = render()
    expect(html).toContain('role="alert"')
    expect(html).toMatch(/aren’t being saved/)
    expect(html).toMatch(/close when you quit/)
  })

  it('does not claim the held daemon’s terminals still work', () => {
    // They do not. Discovery runs over the same IPC the daemon is failing to answer, so its
    // sessions are never routed and attach refuses the fallback rather than answering on the
    // daemon's behalf (degraded-daemon-session-routing.ts:23). The processes are alive — which
    // is the whole point of holding — but unreachable until it responds.
    const html = render()
    expect(html).toMatch(/can’t reach those terminals until the host responds/)
    expect(html).not.toMatch(/already open keep working/)
    // And it must not promise automatic recovery: TerminalErrorToast already tells the user to
    // "Reopen this pane to retry", because nothing re-attaches a failed pane on its own.
    expect(html).not.toMatch(/reconnect on their own/)
    expect(html).toMatch(/reopening a pane retries/)
  })

  it('says the restart ends the local terminals too, not just the held ones', () => {
    // Restarting is not free twice over: runRestartDaemon kills the daemon's sessions AND calls
    // shutdownFallbackSessions() first (daemon-init.ts), so the terminals the notice just told
    // the user are running "outside the host" die as well. Naming only half the cost is how a
    // user loses work by clicking the button the banner recommended.
    expect(render()).toMatch(
      /ends every terminal — both the ones it is still holding and the ones running outside it/
    )
  })

  it('offers the restart action, disabled while another daemon action runs', () => {
    // Matched as an attribute, not a substring: the button's utility classes contain
    // `disabled:opacity-50`, so a contains-check passes whether or not it is really disabled.
    const disabledAttribute = /<button[^>]*\sdisabled[=>]/
    expect(render()).toContain('Restart host')
    expect(render({ isBusy: true })).toMatch(disabledAttribute)
    expect(render({ isBusy: false })).not.toMatch(disabledAttribute)
  })
})

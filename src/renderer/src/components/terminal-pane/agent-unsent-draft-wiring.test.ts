import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The unsent-draft marker is only as good as where it is asked to look.
 *
 * It first shipped hooked to `recordTerminalUserInputForLeaf`, which covers paste,
 * menus and CLI sends but NOT typing — typing records activity through the pane
 * session instead, so the marker never appeared. These read the two paths that
 * carry user input and fail if either stops asking.
 */

function read(relativePath: string): string {
  return readFileSync(resolve(import.meta.dirname, relativePath), 'utf8')
}

function functionBody(source: string, assignment: string): string {
  const start = source.indexOf(assignment)
  expect(start).toBeGreaterThan(-1)
  const end = source.indexOf('\n  }', start)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('unsent-draft check wiring', () => {
  it('asks on every real keystroke, which records activity through the pane session', () => {
    const source = read('./pty-connection/direct-ssh-retry-status.ts')
    const recorder = functionBody(source, 'session.recordTerminalInputForHibernation = ')

    expect(recorder).toContain('scheduleAgentUnsentDraftCheck(session.cacheKey)')
  })

  it('asks on the writes that bypass xterm, like paste and CLI sends', () => {
    const source = read('./terminal-input-activity.ts')

    expect(source).toContain('scheduleAgentUnsentDraftCheck(paneKey)')
  })

  it('keys both paths by the same pane key the sidebar row reads', () => {
    const session = read('./pty-connection/connect-pane-pty.ts')
    const activity = read('./terminal-input-activity.ts')
    const probe = read('./terminal-pane-pane-input.ts')

    expect(session).toContain(
      'session.cacheKey = makePaneKey(session.deps.tabId, session.pane.leafId)'
    )
    expect(activity).toContain('makePaneKey(tabId, leafId)')
    expect(probe).toContain('makePaneKey(tabId, pane.leafId)')
  })
})

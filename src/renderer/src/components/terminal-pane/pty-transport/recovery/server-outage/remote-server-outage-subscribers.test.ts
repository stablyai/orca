import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Guards the #50138 revert: tabs, the terminal surface and pane retries must not subscribe to a
// window-wide outage store again, since each such subscriber woke on every pane's outage change.
const sourcePath = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url))

const REMOVED_MODULES = ['./remote-server-outage-signals.ts', './remote-server-pane-retries.ts']

const SUBSCRIBER_SOURCES = [
  '../../../../tab-bar/terminal-tabs/SortableTab.tsx',
  '../../../../terminal/workbench/TerminalSurface.tsx',
  '../../remote-runtime/recovery/TerminalPaneRecoveryPortals.tsx',
  './remote-server-notice-claims.ts'
]

const REMOVED_SUBSCRIBERS = [
  'useTabHasDownServer',
  'useRemoteServerOutageNudge',
  'useReportRemoteServerPaneRetries',
  'RemoteServerOutageCards',
  'RemoteServerPaneVeil'
]

describe('remote server outage subscribers', () => {
  it.each(REMOVED_MODULES)('keeps %s removed', (relative) => {
    expect(existsSync(sourcePath(relative))).toBe(false)
  })

  it.each(SUBSCRIBER_SOURCES)('%s subscribes to no window-wide outage store', (relative) => {
    const source = readFileSync(sourcePath(relative), 'utf8')
    expect(REMOVED_SUBSCRIBERS.filter((name) => source.includes(name))).toEqual([])
  })
})

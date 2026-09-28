// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SplitTerminalPaneDetail } from '@/constants/terminal'
import { POSIX_SETUP_OBSERVED_SCRIPT_ENV } from '../../../../shared/typed-setup-shell-command'
import {
  _resetTerminalPaneSplitRequestRoutingForTests,
  dispatchTerminalPaneSplitRequest
} from './terminal-pane-split-request-routing'
import type * as LifecyclePrimitives from './terminal-pane-lifecycle-primitives'
import {
  installTerminalPaneMountEvents,
  type TerminalPaneMountEventsManager
} from './terminal-pane-mount-events'

vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('@/runtime/sync-runtime-graph', () => ({ scheduleRuntimeGraphSync: vi.fn() }))
vi.mock('@/runtime/web-runtime-session', () => ({
  consumePendingWebRuntimeSplitMirrorTelemetry: vi.fn(() => false)
}))
vi.mock('../terminal/terminal-tab-actions', () => ({ closeTerminalTab: vi.fn() }))
vi.mock('./terminal-pane-lifecycle-close', () => ({ applyTerminalPaneCloseRequest: vi.fn() }))
vi.mock('./terminal-pane-lifecycle-primitives', async (importOriginal) => ({
  ...(await importOriginal<typeof LifecyclePrimitives>()),
  recordRuntimeCreatedTerminalPaneSplit: vi.fn(() => true)
}))

const TAB_ID = 'tab-setup'
const SETUP_COMMAND = 'bash -lc \'eval "$ORCA_SETUP_OBSERVED_SCRIPT"\''
const SETUP_SCRIPT = 'bash /repo/.git/orca/setup-runner.sh'

function splitDetail(overrides: Partial<SplitTerminalPaneDetail> = {}): SplitTerminalPaneDetail {
  return { tabId: TAB_ID, paneRuntimeId: 4, direction: 'vertical', ...overrides }
}

function installedSplitHandler(): {
  ptyDeps: { startup?: LifecyclePrimitives.SplitStartupPayload | null }
  startupSeenBySplit: LifecyclePrimitives.SplitStartupPayload[]
  dispose: () => void
} {
  const startupSeenBySplit: LifecyclePrimitives.SplitStartupPayload[] = []
  const ptyDeps: { startup?: LifecyclePrimitives.SplitStartupPayload | null } = { startup: null }
  const manager: TerminalPaneMountEventsManager = {
    getNumericIdForLeaf: () => null,
    getPanes: () => [{}, {}],
    closePane: vi.fn(),
    detachPaneForExternalMove: vi.fn(() => true),
    retirePanePreservingPty: vi.fn(() => true),
    splitPane: () => {
      if (ptyDeps.startup) {
        startupSeenBySplit.push(ptyDeps.startup)
      }
      return { id: 9 }
    }
  }
  const dispose = installTerminalPaneMountEvents({
    deps: {
      tabId: TAB_ID,
      worktreeId: 'wt-1',
      isActive: true,
      managerRef: { current: manager },
      persistLayoutSnapshot: vi.fn(),
      syncCanExpandState: vi.fn(),
      queueResizeAll: vi.fn()
    },
    ptyDeps
  })
  return { ptyDeps, startupSeenBySplit, dispose }
}

beforeEach(() => {
  _resetTerminalPaneSplitRequestRoutingForTests()
})

afterEach(() => {
  _resetTerminalPaneSplitRequestRoutingForTests()
})

describe('installTerminalPaneMountEvents split requests', () => {
  // Why this hop needs its own test: the typed Setup command is only `eval "$ORCA_SETUP_OBSERVED_SCRIPT"`,
  // so a renderer-owned Setup split that drops `env` runs a no-op that exits 0 and never signals (#18059).
  it('hands the split pane the setup script env the request carried', () => {
    const installed = installedSplitHandler()

    dispatchTerminalPaneSplitRequest(
      splitDetail({
        command: SETUP_COMMAND,
        env: { [POSIX_SETUP_OBSERVED_SCRIPT_ENV]: SETUP_SCRIPT }
      })
    )

    expect(installed.startupSeenBySplit).toEqual([
      { command: SETUP_COMMAND, env: { [POSIX_SETUP_OBSERVED_SCRIPT_ENV]: SETUP_SCRIPT } }
    ])
    // Why: the one-shot slot must close again, or the next pane to mount inherits this command.
    expect(installed.ptyDeps.startup).toBeNull()
    installed.dispose()
  })

  it('omits env entirely for a split request that carries none', () => {
    const installed = installedSplitHandler()

    dispatchTerminalPaneSplitRequest(splitDetail({ command: 'orca issue' }))

    expect(installed.startupSeenBySplit).toEqual([{ command: 'orca issue' }])
    installed.dispose()
  })
})

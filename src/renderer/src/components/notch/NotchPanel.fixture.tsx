import { defineFixture } from '../../component-fixtures/component-fixture'
import { NotchPanel } from './NotchPanel'
import { buildCollapsedBarLayout } from '../../../../shared/notch/notch-bar-geometry'
import {
  computeNotchPanelMetrics,
  expandedWindowRect,
  collapsedWindowRect
} from '../../../../shared/notch/notch-panel-rect'
import { toNotchSnapshot, type NotchRow } from '../../../../shared/notch/notch-snapshot'
import type { NotchStatusSummary } from '../../../../shared/notch/notch-status-summary'

const now = Date.now()
const rows: NotchRow[] = [
  {
    executionHostId: 'local',
    sessionId: null,
    paneKey: 'approval',
    lane: 'attention',
    state: 'waiting',
    title: 'Review API changes',
    subtitle: '',
    agentType: 'claude',
    stateStartedAt: now - 120000,
    worktreeId: 'api',
    repoId: 'repo',
    tabId: 'approval',
    leafId: null
  },
  {
    executionHostId: 'local',
    sessionId: null,
    paneKey: 'working',
    lane: 'working',
    state: 'working',
    title: 'Orca · agent status',
    subtitle: '',
    agentType: 'codex',
    stateStartedAt: now - 485000,
    worktreeId: 'orca',
    repoId: 'repo',
    tabId: 'working',
    leafId: null
  },
  {
    executionHostId: 'local',
    sessionId: null,
    paneKey: 'done',
    lane: 'done',
    state: 'done',
    title: 'Fix terminal scrollback',
    subtitle: '',
    agentType: 'claude',
    stateStartedAt: now - 60000,
    worktreeId: 'terminal',
    repoId: 'repo',
    tabId: 'done',
    leafId: null
  }
]
const summary: NotchStatusSummary = { counts: { working: 1, attention: 1, done: 1 }, sessions: [] }

function fixture(notch: boolean, expanded: boolean, idle = false) {
  const metrics = computeNotchPanelMetrics({
    displayId: 1,
    bounds: { x: 0, y: 0, width: 1512, height: 982 },
    menuBarHeight: 32,
    safeAreaTop: notch ? 32 : 0,
    notchLeadingX: notch ? 663 : null,
    notchTrailingX: notch ? 849 : null
  })
  const current = idle ? { counts: { working: 0, attention: 0, done: 0 }, sessions: [] } : summary
  const layout = buildCollapsedBarLayout({
    summary: current,
    presentation: metrics.presentation,
    panelWidth: metrics.panelWidth,
    panelOriginX: metrics.panelOriginX,
    notchLeadingX: metrics.notchLeadingX,
    notchWidth: metrics.notchWidth
  })
  const rect = expanded
    ? expandedWindowRect(metrics, rows.length)
    : collapsedWindowRect(metrics, layout)
  const snapshot = toNotchSnapshot(current, layout, metrics, idle ? [] : rows, expanded, 1)
  return defineFixture({
    width: rect.width + 32,
    render: () => (
      <div className="dark" style={{ width: rect.width, height: rect.height }}>
        <NotchPanel snapshot={snapshot} />
      </div>
    )
  })
}

export const expandedNotch = fixture(true, true)
export const collapsedNotch = fixture(true, false)
export const capsule = fixture(false, true)
export const idle = fixture(true, false, true)

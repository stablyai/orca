import type { OracleCheck, OracleFinding } from './helpers/workspace-layout-oracle'

/**
 * Findings the layout oracle still reports on main, each tied to its cause. A rework PR that fixes
 * one removes its entry; any finding not listed here fails the scenario.
 */
type KnownOnMain = {
  /** A scenario id; a trailing '*' matches every id with that prefix. */
  scenario: string
  check: OracleCheck
  /** Prefix of the step label. */
  step?: string
  /** Only breaches seen while a step settled, not the settled layout. */
  transient?: true
  /** Rules only: the rule name each detail line starts with. */
  rule?: string
  /** Pattern the detail line must match. */
  detail?: RegExp
  cause: string
}

const TRANSIENT = /\(transient\)$/

export const LAYOUT_ORACLE_KNOWN_ON_MAIN: readonly KnownOnMain[] = [
  // Two writers: main saves a new tab's row when its terminal starts; the window saves the tab
  // bar later. Rows and tab bar disagree until the window's save lands.
  {
    scenario: '*',
    check: 'rules',
    transient: true,
    rule: 'tab_lists_disagree',
    cause: 'two writers'
  },
  {
    scenario: '*',
    check: 'rules',
    transient: true,
    rule: 'tab_bar_missing',
    cause: 'two writers'
  },
  // STA-9417: first activation of a host-created setup split mints a second tab for the setup
  // terminal (one terminal in two panes) or leaves that terminal with no pane.
  ...(['rules', 'view', 'client', 'expected', 'marker'] as const).map((check) => ({
    scenario: 'setup-split-first-activation',
    check,
    cause: 'STA-9417'
  })),
  // Three copies of tab order: a reorder or a cold relaunch moves the tab bar, not the rows.
  {
    scenario: 'client-reorder-tabs',
    check: 'rules',
    rule: 'tab_order_disagrees',
    cause: 'one tab order'
  },
  {
    scenario: 'cold-daemon-restart',
    check: 'rules',
    rule: 'tab_order_disagrees',
    cause: 'one tab order'
  },
  // After a cold relaunch the paired-client tab list stays empty while the window shows the tabs.
  {
    scenario: 'cold-daemon-restart',
    check: 'client',
    step: 'after cold relaunch',
    cause: 'client tab list empty after cold relaunch'
  },
  // The in-app daemon restart drops the worktree's tabs from main while the window keeps them.
  ...(['view', 'expected', 'restart', 'marker'] as const).map((check) => ({
    scenario: 'live-daemon-restart',
    check,
    cause: 'daemon restart empties the runtime layout'
  })),
  // A worktree woken after relaunch has no tab bar in main until the window next saves it.
  ...(['rules', 'view', 'client', 'restart'] as const).map((check) => ({
    scenario: 'sleep-quit-resume',
    check,
    step: 'after relaunch',
    cause: 'tab bar not saved after wake'
  })),
  {
    scenario: 'sleep-quit-resume',
    check: 'restart',
    step: 'relaunch',
    cause: 'tab bar not saved after wake'
  },
  // Headless runtimes save tab rows and no tab bar; a close then saves a tab bar that lacks the
  // tabs still open.
  {
    scenario: 'headless-*',
    check: 'rules',
    rule: 'tab_bar_missing',
    cause: 'headless saves no tab bar'
  },
  {
    scenario: 'headless-*',
    check: 'rules',
    rule: 'tab_lists_disagree',
    cause: 'headless close saves a partial tab bar'
  },
  // After a relaunch main holds the tab rows but no tab bar for the worktree until the window
  // saves again; slow enough on Linux CI to outlast the settle wait.
  ...(['tab_lists_disagree', 'tab_bar_missing'] as const).flatMap((rule) =>
    ['after relaunch', 'after cold relaunch'].map((step) => ({
      scenario: '*',
      check: 'rules' as const,
      step,
      rule,
      cause: 'tab bar not saved after relaunch'
    }))
  ),
  ...['after relaunch', 'after cold relaunch'].map((step) => ({
    scenario: '*',
    check: 'view' as const,
    step,
    detail: /^drawn group \S+ is not in the runtime/,
    cause: 'tab bar not saved after relaunch'
  })),
  ...['relaunch', 'cold relaunch'].map((step) => ({
    scenario: '*',
    check: 'restart' as const,
    step,
    // Only the groups going missing; lost tabs or panes still fail.
    detail: /: groups \[.*\] vs after restart \[\]$/,
    cause: 'tab bar not saved after relaunch'
  })),
  // A renamed terminal's title lists as null after a serve restart (session tabs keep it): orcad
  // everywhere, Electron serve on Linux.
  {
    scenario: 'headless-*',
    check: 'expected',
    step: 'rename after restart',
    cause: 'orcad title after restart'
  },
  // Headless group moves save the groups but still no tab bar, so the groups list tabs the tab bar
  // lacks.
  ...(['orcad', 'electron'] as const).flatMap((kind) =>
    ['split-tab-into-new-group', 'move-tab-between-groups'].map((id) => ({
      scenario: `headless-${kind}-${id}`,
      check: 'rules' as const,
      rule: 'group_lists_missing_tab',
      cause: 'headless saves groups but no tab bar'
    }))
  ),
  // After a headless move into an existing group, paired clients still see that group's previous
  // tab selected, not the moved one. A split into a new group selects the moved tab.
  ...(['orcad', 'electron'] as const).map((kind) => ({
    scenario: `headless-${kind}-move-tab-between-groups`,
    check: 'expected' as const,
    step: 'move',
    detail: /^group \S+ selects /,
    cause: 'headless move-to-group keeps the target group selection'
  }))
]

function covers(
  known: KnownOnMain,
  scenario: string,
  finding: OracleFinding,
  detail: string
): boolean {
  const scenarioMatches = known.scenario.endsWith('*')
    ? scenario.startsWith(known.scenario.slice(0, -1))
    : known.scenario === scenario
  if (!scenarioMatches) {
    return false
  }
  if (known.check !== finding.check) {
    return false
  }
  if (known.transient && !TRANSIENT.test(finding.step)) {
    return false
  }
  if (known.step !== undefined && !finding.step.startsWith(known.step)) {
    return false
  }
  if (known.detail !== undefined && !known.detail.test(detail)) {
    return false
  }
  return known.rule === undefined || detail.startsWith(`${known.rule}:`)
}

/** The findings, reduced to the detail lines no known-on-main entry covers. */
export function unexpectedFindings(
  scenario: string,
  findings: readonly OracleFinding[]
): OracleFinding[] {
  return findings.flatMap((finding) => {
    const details = finding.details.filter(
      (detail) =>
        !LAYOUT_ORACLE_KNOWN_ON_MAIN.some((known) => covers(known, scenario, finding, detail))
    )
    return details.length > 0 ? [{ check: finding.check, step: finding.step, details }] : []
  })
}

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
  /** Only on this OS: the one every run that reproduced it ran on. Absent: reproduced on both. */
  platform?: 'darwin' | 'linux'
  cause: string
}

const TRANSIENT = /\(transient\)$/

export const LAYOUT_ORACLE_KNOWN_ON_MAIN: readonly KnownOnMain[] = [
  // A headless host lists a worktree with no saved tab bar (and, after a restart, every worktree)
  // under a synthesized `headless-terminals:` group, while the layout stream names the same group
  // by its saved or minted id: same tabs and order, two group ids. One projection in PR 6.
  {
    scenario: 'headless-*',
    check: 'client',
    detail: /^group id differs: runtime \S+, client headless-terminals:\S+ \(tabs /,
    cause: 'two group ids'
  },
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
  if (!scenarioMatches || (known.platform && known.platform !== process.platform)) {
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

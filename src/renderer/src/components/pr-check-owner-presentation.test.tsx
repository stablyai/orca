// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { CircleDashed } from 'lucide-react'
import { acceptPRCheckObservation } from '../../../shared/github/complete-pr-check-owner'
import { getCheckCounts, getOverallCheckCounts, getChecksSummaryLabel } from './pr-check-counts'
import { ChecksTabLayouts } from './pull-request-page/checks/layouts'
import { ChecksCompactHeader } from './pull-request-page/checks/toolbar'
import { ChecksTabCompactHeader } from './github-item-dialog/inspect-pull-request/checks-tab-header'
import { getChecksTabSummaryPresentation } from './github-item-dialog/inspect-pull-request/checks-tab-summary'
import { PRTriageStrip } from './right-sidebar/checks-panel/presentation/triage-strip'
import { i18n } from '@/i18n/i18n'
import type { PRCheckDetail } from '../../../shared/github/check-types'

const owner = {
  number: 42,
  url: 'https://github.com/acme/widgets/pull/42',
  headSha: 'a'.repeat(40),
  mergeable: 'UNKNOWN' as const
}
const context = { scope: 'account:runtime', complete: true, current: true }
const blocked = {
  state: 'failure' as const,
  total: 101,
  passed: 100,
  failed: 1,
  pending: 0,
  neutral: 0
}
const rows: PRCheckDetail[] = [
  {
    name: 'Approval',
    status: 'completed',
    conclusion: 'action_required',
    url: null,
    observedHeadSha: 'a'.repeat(40)
  }
]
afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('en')
})

it.each([ChecksCompactHeader, ChecksTabCompactHeader])(
  'keeps row approval chips while only current associated rows explain an owner failure',
  (Header) => {
    const accepted = acceptPRCheckObservation({ ...owner, checksSummary: blocked }, null, context)!
    const counts = getCheckCounts(rows)
    expect(counts).toMatchObject({ passing: 0, failing: 0, needsAction: 1 })
    const overall = getOverallCheckCounts(rows, accepted, accepted)
    render(
      <Header
        {...getChecksTabSummaryPresentation(overall)}
        counts={overall}
        summaryLabel={getChecksSummaryLabel(rows, accepted, accepted)}
        listLength={1}
        refreshAction={<button>Refresh</button>}
        rerunAction={null}
        secondaryActions={null}
      />
    )
    expect(screen.getByText('1 check needs action')).toBeTruthy()
    cleanup()
    const newer = acceptPRCheckObservation(
      { ...owner, checksSummary: { ...blocked } },
      accepted,
      context
    )!
    const nextCounts = getOverallCheckCounts(rows, newer, accepted)
    render(
      <Header
        {...getChecksTabSummaryPresentation(nextCounts)}
        counts={nextCounts}
        summaryLabel={getChecksSummaryLabel(rows, newer, accepted)}
        listLength={1}
        refreshAction={<button>Refresh</button>}
        rerunAction={null}
        secondaryActions={null}
      />
    )
    expect(screen.getByText('1 check failing')).toBeTruthy()
    expect(
      getOverallCheckCounts(
        rows,
        acceptPRCheckObservation(
          { ...owner, checksSummary: { ...blocked, failed: 2, total: 102 } },
          null,
          context
        )!,
        accepted
      ).failing
    ).toBe(2)
  }
)

it.each(['page', 'compact'] as const)(
  'does not claim zero whole checks in the empty %s renderer',
  async (variant) => {
    i18n.addResourceBundle(
      'es',
      'translation',
      {
        auto: {
          components: {
            right: { sidebar: { ChecksPanel: { '976cefd02f': 'Comprobaciones no disponibles' } } },
            prCheckCounts: { noCheckDetails: 'No hay detalles de comprobaciones' }
          }
        }
      },
      true,
      true
    )
    await i18n.changeLanguage('es')
    const accepted = acceptPRCheckObservation(owner, null, context)!
    const summaryLabel = getChecksSummaryLabel([], accepted)
    render(
      <ChecksTabLayouts
        owner={accepted}
        loading={false}
        listLength={0}
        variant={variant}
        compactHeader={<div>{summaryLabel}</div>}
        actions={<button>Refresh</button>}
        SummaryIcon={CircleDashed}
        summaryColor=""
        summaryLabel={summaryLabel}
        counts={getCheckCounts([])}
        summaryPending={false}
        sorted={[]}
        renderCheckRow={() => <div />}
        fixChecksAgentDialog={<span />}
      />
    )
    expect(screen.getByText('Comprobaciones no disponibles')).toBeTruthy()
    expect(screen.getByText('No hay detalles de comprobaciones')).toBeTruthy()
    expect(screen.queryByText('No checks found')).toBeNull()
  }
)

it('keeps the row Fix action available when the complete owner is unavailable', () => {
  const accepted = acceptPRCheckObservation(owner, null, context)!
  render(
    <PRTriageStrip
      review={accepted}
      checks={[{ name: 'Build', status: 'completed', conclusion: 'failure', url: null }]}
      isResolvingConflictsWithAI={false}
      onResolveConflictsWithAI={() => {}}
      isFixingChecksWithAI={false}
      onFixChecksWithAI={() => {}}
    />
  )
  expect(screen.getByText('Checks unavailable')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Fix' }).hasAttribute('disabled')).toBe(false)
})

it('keeps a successful whole owner presentation when independent rows still contain an old failure', () => {
  const accepted = acceptPRCheckObservation(
    { ...owner, checksSummary: { ...blocked, state: 'success', total: 1, passed: 1, failed: 0 } },
    null,
    context
  )!
  render(
    <PRTriageStrip
      review={accepted}
      checks={[{ name: 'Build', status: 'completed', conclusion: 'failure', url: null }]}
      isResolvingConflictsWithAI={false}
      onResolveConflictsWithAI={() => {}}
      isFixingChecksWithAI={false}
      onFixChecksWithAI={() => {}}
    />
  )
  expect(screen.getByText('No blocking PR action')).toBeTruthy()
  expect(screen.queryByText('0 failing checks')).toBeNull()
})

it.each([false, true])('keeps a failed parent pipeline fixable with empty jobs: %s', (empty) => {
  const fix = vi.fn()
  const props = {
    review: owner,
    reviewKind: 'MR' as const,
    checks: empty ? [] : rows.map((row) => ({ ...row, conclusion: 'success' as const })),
    pipelineCheck: {
      name: 'Pipeline',
      status: 'completed' as const,
      conclusion: 'failure' as const,
      url: null
    },
    isResolvingConflictsWithAI: false,
    onResolveConflictsWithAI: () => {},
    isFixingChecksWithAI: false,
    onFixChecksWithAI: fix
  }
  const view = render(<PRTriageStrip {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Fix' }))
  expect(fix).toHaveBeenCalledOnce()
  view.rerender(<PRTriageStrip {...props} fixChecksDisabled />)
  expect(screen.getByRole('button', { name: 'Fix' }).hasAttribute('disabled')).toBe(true)
  view.rerender(<PRTriageStrip {...props} isFixingChecksWithAI />)
  expect(screen.getByRole('button', { name: 'Fix' }).hasAttribute('disabled')).toBe(true)
  const accepted = acceptPRCheckObservation({ ...owner, checksSummary: blocked }, null, context)!
  view.rerender(
    <PRTriageStrip {...props} reviewKind="PR" review={accepted} checks={[]} pipelineCheck={null} />
  )
  expect(screen.getByRole('button', { name: 'Fix' }).hasAttribute('disabled')).toBe(true)
})

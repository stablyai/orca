// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { acceptPRCheckObservation } from '../../../shared/github/complete-pr-check-owner'
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

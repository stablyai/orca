// @vitest-environment happy-dom

// R17. Two properties, both about honesty and authority:
//  - an absence is never rendered as a judgement ("Not yet audited", never
//    "0 of 2 covered");
//  - the checklist is strictly read-only, so no renderer interaction could ever
//    become a coverage write.
import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuditedTaskStatusProjection } from '../../../../shared/audited-workflow-types'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

import { AuditedCoverageChecklist } from './AuditedCoverageChecklist'

function task(overrides: Partial<AuditedTaskStatusProjection> = {}): AuditedTaskStatusProjection {
  return {
    taskId: 'audited_1',
    state: 'awaiting_plan_review',
    coverageAvailable: false,
    acceptanceCriteria: [],
    ...overrides
  } as AuditedTaskStatusProjection
}

const CRITERIA = [
  { id: 'ac1', text: 'The parser rejects an unknown verdict.', covered: true, note: 'Step 3' },
  { id: 'ac2', text: 'A cancelled run leaves no orphan process.', covered: false }
]

afterEach(cleanup)

describe('AuditedCoverageChecklist', () => {
  it('renders nothing when the task has no criteria', () => {
    const { container } = render(<AuditedCoverageChecklist task={task()} />)
    expect(container).toBeEmptyDOMElement()
  })

  // The central rule: never present an unobserved absence as a finding.
  it('says "not yet audited" rather than counting zero when no audit has run', () => {
    render(
      <AuditedCoverageChecklist
        task={task({ coverageAvailable: false, acceptanceCriteria: CRITERIA })}
      />
    )
    expect(screen.getByText(/Not yet audited/i)).toBeInTheDocument()
    expect(screen.queryByText(/0 of 2 covered/i)).not.toBeInTheDocument()
  })

  it('shows the count and every criterion once audited', () => {
    render(
      <AuditedCoverageChecklist
        task={task({ coverageAvailable: true, acceptanceCriteria: CRITERIA })}
      />
    )
    expect(screen.getByText('1 of 2 covered')).toBeInTheDocument()
    expect(screen.getByText(CRITERIA[0].text)).toBeInTheDocument()
    expect(screen.getByText(CRITERIA[1].text)).toBeInTheDocument()
    expect(screen.getByText('Covered')).toBeInTheDocument()
    expect(screen.getByText('Not covered')).toBeInTheDocument()
  })

  it('shows a note only where the audit gave one', () => {
    render(
      <AuditedCoverageChecklist
        task={task({ coverageAvailable: true, acceptanceCriteria: CRITERIA })}
      />
    )
    expect(screen.getByText('Step 3')).toBeInTheDocument()
  })

  // Read-only by construction: with no interactive element, there is no renderer
  // path to a coverage mutation even if an IPC channel later existed.
  it('exposes no interactive control', () => {
    const { container } = render(
      <AuditedCoverageChecklist
        task={task({ coverageAvailable: true, acceptanceCriteria: CRITERIA })}
      />
    )
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    expect(container.querySelectorAll('input, button, select, textarea')).toHaveLength(0)
  })

  it('counts every criterion as uncovered when the audit recorded none', () => {
    render(
      <AuditedCoverageChecklist
        task={task({
          coverageAvailable: true,
          acceptanceCriteria: CRITERIA.map((c) => ({ ...c, covered: false, note: undefined }))
        })}
      />
    )
    expect(screen.getByText('0 of 2 covered')).toBeInTheDocument()
  })
})

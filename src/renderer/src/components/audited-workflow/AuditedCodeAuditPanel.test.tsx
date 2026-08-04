// @vitest-environment happy-dom

// U1. Two properties:
//  - the panel offers exactly the affordance the SERVER says is legal, never one
//    it derives itself;
//  - nothing identifying is rendered — no path, diff, prompt, log, or tree OID.
import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuditedTaskStatusProjection } from '../../../../shared/audited-workflow-types'

type StoreState = {
  startAuditedCodeAudit: ReturnType<typeof vi.fn>
  cancelAuditedCodeAudit: ReturnType<typeof vi.fn>
  retryAuditedCodeAudit: ReturnType<typeof vi.fn>
  requestAuditedCodeFix: ReturnType<typeof vi.fn>
  auditedCodeAuditPendingTaskId: string | null
}

const mocks = vi.hoisted(() => ({ storeState: {} as StoreState }))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: StoreState) => unknown) => selector(mocks.storeState)
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

import { AuditedCodeAuditPanel } from './AuditedCodeAuditPanel'

function task(overrides: Partial<AuditedTaskStatusProjection> = {}): AuditedTaskStatusProjection {
  return {
    taskId: 'audited_1',
    state: 'awaiting_code_audit',
    fixRound: 0,
    candidateAvailable: true,
    codeAuditRunStatus: null,
    codeAuditVerdict: null,
    codeAuditReasonCode: null,
    codeAuditSummary: null,
    codeAuditFindingCount: null,
    codeFixAvailable: false,
    ...overrides
  } as AuditedTaskStatusProjection
}

beforeEach(() => {
  mocks.storeState = {
    startAuditedCodeAudit: vi.fn().mockResolvedValue({ ok: true }),
    cancelAuditedCodeAudit: vi.fn().mockResolvedValue({ ok: true }),
    retryAuditedCodeAudit: vi.fn().mockResolvedValue({ ok: true }),
    requestAuditedCodeFix: vi.fn().mockResolvedValue({ ok: true }),
    auditedCodeAuditPendingTaskId: null
  }
})

afterEach(cleanup)

describe('mounting', () => {
  it.each(['selected', 'planning', 'implementing', 'awaiting_human_approval', 'blocked'])(
    'renders nothing in %s',
    (state) => {
      const { container } = render(<AuditedCodeAuditPanel task={task({ state: state as never })} />)
      expect(container).toBeEmptyDOMElement()
    }
  )

  it.each(['awaiting_code_audit', 'code_fixes_requested'])('mounts in %s', (state) => {
    const { container } = render(<AuditedCodeAuditPanel task={task({ state: state as never })} />)
    expect(container).not.toBeEmptyDOMElement()
  })
})

describe('affordances', () => {
  it('offers Run Code Audit when a candidate exists', async () => {
    render(<AuditedCodeAuditPanel task={task()} />)
    const button = screen.getByRole('button', { name: 'Run Code Audit' })
    expect(button).toBeEnabled()

    await userEvent.click(button)
    expect(mocks.storeState.startAuditedCodeAudit).toHaveBeenCalledWith('audited_1')
  })

  // Gated on the SERVER-computed boolean, not on anything the renderer derives.
  it('disables Run Code Audit with an explanation when no candidate exists', () => {
    render(<AuditedCodeAuditPanel task={task({ candidateAvailable: false })} />)
    expect(screen.getByRole('button', { name: 'Run Code Audit' })).toBeDisabled()
    expect(screen.getByText(/No reviewable change set yet/)).toBeInTheDocument()
  })

  it('offers only Cancel while an audit is running', () => {
    render(<AuditedCodeAuditPanel task={task({ codeAuditRunStatus: 'running' })} />)
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Run Code Audit' })).not.toBeInTheDocument()
  })

  it('offers Request Fix in code_fixes_requested when below the cap', async () => {
    render(
      <AuditedCodeAuditPanel
        task={task({ state: 'code_fixes_requested', codeFixAvailable: true, fixRound: 1 })}
      />
    )
    const button = screen.getByRole('button', { name: 'Request Fix' })
    expect(button).toBeEnabled()

    await userEvent.click(button)
    expect(mocks.storeState.requestAuditedCodeFix).toHaveBeenCalledWith('audited_1')
  })

  it('disables Request Fix at the cap and says why', () => {
    render(
      <AuditedCodeAuditPanel
        task={task({ state: 'code_fixes_requested', codeFixAvailable: false, fixRound: 3 })}
      />
    )
    expect(screen.getByRole('button', { name: 'Request Fix' })).toBeDisabled()
    expect(screen.getByText('The fix limit has been reached.')).toBeInTheDocument()
  })

  it('offers Retry only for a retryable failure', () => {
    render(<AuditedCodeAuditPanel task={task({ codeAuditReasonCode: 'timeout' })} />)
    expect(screen.getByRole('button', { name: 'Retry Audit' })).toBeInTheDocument()

    cleanup()
    // A busy state clears on its own, so Retry would race the run holding the
    // lane — the message is shown without an action.
    render(<AuditedCodeAuditPanel task={task({ codeAuditReasonCode: 'execution_in_progress' })} />)
    expect(screen.queryByRole('button', { name: 'Retry Audit' })).not.toBeInTheDocument()
    expect(screen.getByText(/A code change is still running/)).toBeInTheDocument()
  })

  it('explains a discarded verdict after drift', () => {
    render(<AuditedCodeAuditPanel task={task({ codeAuditReasonCode: 'candidate_drift' })} />)
    expect(screen.getByText(/The working tree changed during the audit/)).toBeInTheDocument()
  })
})

describe('what is rendered', () => {
  it('shows the verdict badge, summary, and finding count', () => {
    render(
      <AuditedCodeAuditPanel
        task={task({
          codeAuditVerdict: 'fixes_requested',
          codeAuditSummary: 'Two defects found.',
          codeAuditFindingCount: 2
        })}
      />
    )
    expect(screen.getByText('Two defects found.')).toBeInTheDocument()
    expect(screen.getByText('2 findings.')).toBeInTheDocument()
  })

  it('shows the fix round against the cap', () => {
    render(<AuditedCodeAuditPanel task={task({ fixRound: 2 })} />)
    expect(screen.getByText('Fix round 2 of 3')).toBeInTheDocument()
  })

  // The trust boundary, asserted on rendered text.
  it('renders no path, tree OID, or prompt', () => {
    const { container } = render(
      <AuditedCodeAuditPanel
        task={task({
          codeAuditVerdict: 'approved',
          codeAuditSummary: 'The change is correct.',
          candidateIdShort: 'abc123def456'
        })}
      />
    )
    const text = container.textContent ?? ''
    expect(text).not.toMatch(/[/\\](Users|home|tmp)[/\\]/)
    expect(text).not.toMatch(/\b[0-9a-f]{40}\b/)
    expect(text).not.toContain('.git')
  })
})

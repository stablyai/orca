// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ProgressMeter,
  RunProgressSection,
  TechnicalDisclosure
} from './MaestroRunProgressSections'

afterEach(cleanup)

describe('MaestroRunProgressSections', () => {
  it('announces authoritative terminal-task progress', () => {
    render(<ProgressMeter completed={2} total={2} percent={100} />)

    expect(screen.getByRole('progressbar').getAttribute('aria-label')).toBe(
      '2 of 2 tasks complete, 100 percent'
    )
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100')
  })

  it('omits a guessed percentage for a zero-Task Run', () => {
    render(<ProgressMeter completed={0} total={0} />)

    expect(screen.getByRole('progressbar').getAttribute('aria-label')).toBe('No tasks in this Run')
    expect(screen.getByRole('progressbar').hasAttribute('aria-valuenow')).toBe(false)
  })

  it('activates a human row through its technical reference', () => {
    const activate = vi.fn()
    render(
      <RunProgressSection
        label="Current work"
        rows={[
          {
            key: 'current:task-1',
            reference: 'task-1',
            title: 'Harden desktop progress',
            workerLabel: 'Frontend specialist',
            detail: 'Validating compact and hidden states',
            state: 'running'
          }
        ]}
        onActivate={activate}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /Harden desktop progress/ }))
    expect(activate).toHaveBeenCalledWith('task-1')
    expect(screen.getByText('Frontend specialist')).not.toBeNull()
    expect(screen.getByText('Validating compact and hidden states')).not.toBeNull()
  })

  it('expands a row to reveal its full title and detail', () => {
    render(
      <RunProgressSection
        label="Run resources"
        rows={[
          {
            key: 'resource:task-1',
            reference: 'task-1',
            title: 'A long task title that needs more than the compact row width',
            detail: 'A detailed explanation that remains readable after the row is expanded.',
            state: 'running'
          }
        ]}
        onActivate={vi.fn()}
      />
    )

    const row = screen.getByRole('button', { name: /A long task title/ })
    const title = screen.getByText(/A long task title/)
    expect(row.getAttribute('aria-expanded')).toBe('false')
    expect(title.className).toContain('truncate')

    fireEvent.click(row)

    expect(row.getAttribute('aria-expanded')).toBe('true')
    expect(title.className).not.toContain('truncate')
  })

  it('keeps identifiers inside technical disclosure', () => {
    render(<TechnicalDisclosure entries={[{ label: 'Run', value: 'run_technical_identifier' }]} />)

    expect(screen.getByText('Technical details').closest('details')?.hasAttribute('open')).toBe(
      false
    )
    expect(screen.getByText('run_technical_identifier')).not.toBeNull()
  })
})

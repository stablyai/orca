// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import { i18n } from '@/i18n/i18n'
import { AgentTaskDetails } from './AgentTaskDetails'
import { taskNoteIdentity } from './agent-task-status'
import { useDashboardTaskNotes } from './use-dashboard-task-notes'

const done: DashboardCard = {
  paneKey: 'details-test',
  ptyId: null,
  agentType: 'codex',
  bucket: 'done',
  dotState: 'done',
  task: '',
  repoId: 'repo',
  worktreeId: 'folder',
  tabId: 'tab',
  leafId: null,
  repoName: 'Example',
  worktreeName: 'Sources',
  startedAt: 10,
  finishedAt: 20,
  stateChangedAt: 20,
  unseen: true
}

function choose(label: string): void {
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' })
  fireEvent.click(screen.getByRole('option', { name: label }))
}

describe('task details', () => {
  beforeEach(async () => {
    localStorage.clear()
    await i18n.changeLanguage('en')
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('requires a review reference and saves an explicit confirmation for this response', () => {
    const save = vi.fn()
    render(<AgentTaskDetails card={done} onSave={save} />)
    fireEvent.click(screen.getByRole('button', { name: 'Task details' }))
    choose('Result verified')
    fireEvent.submit(screen.getByRole('form', { name: 'Task details' }))
    expect(save).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('review reference')
    fireEvent.change(screen.getByLabelText('Review reference'), {
      target: { value: 'reviews/result.md' }
    })
    fireEvent.submit(screen.getByRole('form', { name: 'Task details' }))
    expect(save).toHaveBeenCalledWith(
      done,
      expect.objectContaining({ status: 'verified', reviewReference: 'reviews/result.md' })
    )
  })

  it('allows review after reading and retains edits when acknowledgement arrives while editing', () => {
    const save = vi.fn()
    const { rerender } = render(<AgentTaskDetails card={done} onSave={save} />)
    fireEvent.click(screen.getByRole('button', { name: 'Task details' }))
    choose('Result verified')
    fireEvent.change(screen.getByLabelText('Review reference'), {
      target: { value: 'Reviewed the response' }
    })
    const read = { ...done, bucket: 'idle' as const, unseen: false }
    rerender(<AgentTaskDetails card={read} onSave={save} />)
    fireEvent.submit(screen.getByRole('form', { name: 'Task details' }))
    expect(save).toHaveBeenCalledWith(read, expect.objectContaining({ status: 'verified' }))
  })

  it('does not apply a confirmation if a new turn arrives while editing', () => {
    const save = vi.fn()
    const { rerender } = render(<AgentTaskDetails card={done} onSave={save} />)
    fireEvent.click(screen.getByRole('button', { name: 'Task details' }))
    fireEvent.change(screen.getByLabelText('Current status'), { target: { value: 'Old response' } })
    rerender(
      <AgentTaskDetails card={{ ...done, finishedAt: 30, stateChangedAt: 30 }} onSave={save} />
    )
    fireEvent.submit(screen.getByRole('form', { name: 'Task details' }))
    expect(save).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('agent state changed')
  })

  it('requires an owner and next step for a waiting state', () => {
    const save = vi.fn()
    render(<AgentTaskDetails card={done} onSave={save} />)
    fireEvent.click(screen.getByRole('button', { name: 'Task details' }))
    choose('Waiting for input')
    fireEvent.submit(screen.getByRole('form', { name: 'Task details' }))
    expect(save).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Next step'), {
      target: { value: 'Provide source access' }
    })
    fireEvent.change(screen.getByLabelText('Who acts next'), { target: { value: 'Project owner' } })
    fireEvent.submit(screen.getByRole('form', { name: 'Task details' }))
    expect(save).toHaveBeenCalledWith(
      done,
      expect.objectContaining({ status: 'waiting-input', owner: 'Project owner' })
    )
  })

  it('keeps the draft open when saving fails', () => {
    render(
      <AgentTaskDetails
        card={done}
        onSave={() => {
          throw new Error('Storage unavailable')
        }}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Task details' }))
    fireEvent.change(screen.getByLabelText('Task name'), { target: { value: 'Unsaved task' } })
    fireEvent.submit(screen.getByRole('form', { name: 'Task details' }))
    expect(screen.getByLabelText('Task name')).toHaveValue('Unsaved task')
    expect(screen.getByRole('alert')).toHaveTextContent('could not be saved')
  })

  it('restores saved task details after the board remounts', () => {
    function Board(): React.JSX.Element {
      const { notes, saveNote } = useDashboardTaskNotes()
      return <AgentTaskDetails card={done} note={notes[taskNoteIdentity(done)]} onSave={saveNote} />
    }
    const first = render(<Board />)
    fireEvent.click(screen.getByRole('button', { name: 'Task details' }))
    fireEvent.change(screen.getByLabelText('Task name'), { target: { value: 'Source inventory' } })
    fireEvent.submit(screen.getByRole('form', { name: 'Task details' }))
    first.unmount()
    render(<Board />)
    fireEvent.click(screen.getByRole('button', { name: 'Task details' }))
    expect(screen.getByLabelText('Task name')).toHaveValue('Source inventory')
  })
})

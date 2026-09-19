// @vitest-environment happy-dom
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { BacklogAgentDialog } from './BacklogAgentDialog'
import { useBacklogStore } from '../../store/backlog-store'

describe('BacklogAgentDialog', () => {
  beforeEach(() => {
    useBacklogStore.getState().setBacklogOpen(false)
    useBacklogStore.getState().setViewMode('checklist')
    useBacklogStore.getState().setCategoryFilter('all')
  })

  afterEach(() => {
    cleanup()
    useBacklogStore.getState().setBacklogOpen(false)
  })

  it('renders null when isBacklogOpen is false', () => {
    const { container } = render(<BacklogAgentDialog />)
    expect(container.firstChild).toBeNull()
  })

  it('renders modal dialog when isBacklogOpen is true', () => {
    useBacklogStore.getState().setBacklogOpen(true)
    render(<BacklogAgentDialog />)

    expect(screen.getByTestId('backlog-agent-modal')).toBeDefined()
    expect(screen.getByText('Backlog Agent')).toBeDefined()
    expect(screen.getByText('核選清單')).toBeDefined()
    expect(screen.getByText('看板')).toBeDefined()
  })

  it('switches between checklist and kanban view mode', () => {
    useBacklogStore.getState().setBacklogOpen(true)
    render(<BacklogAgentDialog />)

    const kanbanBtn = screen.getByText('看板')
    fireEvent.click(kanbanBtn)
    expect(useBacklogStore.getState().viewMode).toBe('kanban')

    const checklistBtn = screen.getByText('核選清單')
    fireEvent.click(checklistBtn)
    expect(useBacklogStore.getState().viewMode).toBe('checklist')
  })

  it('adds a new custom task through the input form', () => {
    useBacklogStore.getState().setBacklogOpen(true)
    render(<BacklogAgentDialog />)

    const input = screen.getByPlaceholderText('新增待辦任務...')
    fireEvent.change(input, { target: { value: 'New Test Backlog Item' } })

    const form = input.closest('form')!
    fireEvent.submit(form)

    expect(screen.getByText('New Test Backlog Item')).toBeDefined()
  })
})

// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_JIRA_SAVED_FILTER_JQL_LENGTH,
  MAX_JIRA_SAVED_FILTER_NAME_LENGTH,
  MAX_JIRA_SAVED_FILTERS
} from '../../../shared/jira-saved-filters'
import { TaskPageJiraSavedFilters } from './TaskPageJiraSavedFilters'

const FILTERS = [
  { id: 'mine', name: 'My open work', jql: 'assignee = currentUser() AND statusCategory != Done' },
  { id: 'bugs', name: 'Team bugs', jql: 'project = ORCA AND type = Bug' }
]

afterEach(cleanup)

function renderSavedFilters(
  overrides: Partial<React.ComponentProps<typeof TaskPageJiraSavedFilters>> = {}
) {
  const props: React.ComponentProps<typeof TaskPageJiraSavedFilters> = {
    filters: FILTERS,
    activeFilterId: 'mine',
    currentJql: 'project = ORCA',
    onApply: vi.fn(),
    onCreate: vi.fn(),
    onUpdate: vi.fn(),
    onDelete: vi.fn(),
    ...overrides
  }
  return { user: userEvent.setup(), props, ...render(<TaskPageJiraSavedFilters {...props} />) }
}

describe('TaskPageJiraSavedFilters', () => {
  it('저장된 필터를 한 번의 클릭으로 적용하고 활성 필터를 표시한다', async () => {
    // Given
    const { user, props } = renderSavedFilters()

    // When
    await user.click(screen.getByRole('button', { name: 'Saved filters' }))

    // Then
    const activeFilter = screen.getByRole('button', { name: 'My open work' })
    expect(activeFilter.getAttribute('aria-current')).toBe('true')
    expect(activeFilter.getAttribute('data-current')).toBe('true')

    // When
    await user.click(screen.getByRole('button', { name: 'Team bugs' }))

    // Then
    expect(props.onApply).toHaveBeenCalledOnce()
    expect(props.onApply).toHaveBeenCalledWith(FILTERS[1])
  })

  it('현재 JQL을 새 이름으로 저장하고 필수값과 중복 이름을 검증한다', async () => {
    // Given
    const { user, props, rerender } = renderSavedFilters({ currentJql: '' })
    await user.click(screen.getByRole('button', { name: 'Saved filters' }))
    expect(
      (screen.getByRole('button', { name: 'Save current filter' }) as HTMLButtonElement).disabled
    ).toBe(true)

    // When
    rerender(<TaskPageJiraSavedFilters {...props} currentJql="project = ORCA" />)
    await user.click(screen.getByRole('button', { name: 'Save current filter' }))

    // Then
    const nameInput = screen.getByRole('textbox', { name: 'Name' })
    const jqlInput = screen.getByRole('textbox', { name: 'JQL' })
    expect((jqlInput as HTMLTextAreaElement).value).toBe('project = ORCA')
    expect((nameInput as HTMLInputElement).maxLength).toBe(MAX_JIRA_SAVED_FILTER_NAME_LENGTH)
    expect((jqlInput as HTMLTextAreaElement).maxLength).toBe(MAX_JIRA_SAVED_FILTER_JQL_LENGTH)
    expect(
      (screen.getByRole('button', { name: 'Save filter' }) as HTMLButtonElement).disabled
    ).toBe(true)

    // When
    await user.type(nameInput, '  team BUGS  ')

    // Then
    expect(screen.getByText('A saved filter with this name already exists.')).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: 'Save filter' }) as HTMLButtonElement).disabled
    ).toBe(true)

    // When
    await user.clear(nameInput)
    await user.type(nameInput, '  Current sprint  ')
    await user.click(screen.getByRole('button', { name: 'Save filter' }))

    // Then
    expect(props.onCreate).toHaveBeenCalledWith({
      name: 'Current sprint',
      jql: 'project = ORCA'
    })
  })

  it('활성 필터 편집 Dialog에 현재 JQL을 seed하고 명시적으로 update한다', async () => {
    // Given
    const { user, props } = renderSavedFilters()
    await user.click(screen.getByRole('button', { name: 'Saved filters' }))

    // When
    await user.click(screen.getByRole('button', { name: 'Edit My open work' }))

    // Then
    expect((screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement).value).toBe(
      'My open work'
    )
    expect((screen.getByRole('textbox', { name: 'JQL' }) as HTMLTextAreaElement).value).toBe(
      'project = ORCA'
    )

    // When
    await user.clear(screen.getByRole('textbox', { name: 'Name' }))
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'My active work')
    await user.click(screen.getByRole('button', { name: 'Update filter' }))

    // Then
    expect(props.onUpdate).toHaveBeenCalledWith('mine', {
      name: 'My active work',
      jql: 'project = ORCA'
    })
  })

  it('편집 Dialog에서 destructive Delete action을 제공한다', async () => {
    // Given
    const { user, props } = renderSavedFilters()
    await user.click(screen.getByRole('button', { name: 'Saved filters' }))
    await user.click(screen.getByRole('button', { name: 'Edit Team bugs' }))

    // When
    const deleteButton = screen.getByRole('button', { name: 'Delete filter' })

    // Then
    expect(deleteButton.getAttribute('data-variant')).toBe('destructive')

    // When
    await user.click(deleteButton)

    // Then
    expect(props.onDelete).toHaveBeenCalledWith('bugs')
  })

  it('저장 한도에 도달하면 새 필터 저장을 막고 제한을 안내한다', async () => {
    // Given
    const filters = Array.from({ length: MAX_JIRA_SAVED_FILTERS }, (_, index) => ({
      id: `filter-${index}`,
      name: `Filter ${index}`,
      jql: `project = ORCA AND rank = ${index}`
    }))
    const { user } = renderSavedFilters({ filters })

    // When
    await user.click(screen.getByRole('button', { name: 'Saved filters' }))

    // Then
    expect(
      (screen.getByRole('button', { name: 'Save current filter' }) as HTMLButtonElement).disabled
    ).toBe(true)
    expect(screen.getByText('You can save up to 50 filters.')).toBeTruthy()
  })
})

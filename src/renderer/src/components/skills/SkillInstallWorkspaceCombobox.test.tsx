// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SkillInstallWorkspaceCombobox } from './SkillInstallWorkspaceCombobox'
import type { SkillInstallWorkspaceChoice } from './skill-install-workspace-choices'

const sampleChoices: SkillInstallWorkspaceChoice[] = [
  { id: 'wt-1', label: 'orca-main', kind: 'worktree' },
  { id: 'wt-2', label: 'feature-skills', kind: 'worktree' },
  { id: 'f-1', label: 'dotfiles', kind: 'folder' },
  { id: 'f-2', label: 'scripts-repo', kind: 'folder' }
]

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('SkillInstallWorkspaceCombobox', () => {
  it('renders placeholder when no workspace is selected', () => {
    render(
      <SkillInstallWorkspaceCombobox value="" onValueChange={vi.fn()} choices={sampleChoices} />
    )

    const trigger = screen.getByRole('combobox')
    expect(trigger).toHaveTextContent('Choose a worktree or folder')
    expect(trigger).not.toBeDisabled()
  })

  it('renders selected workspace label and kind badge', () => {
    render(
      <SkillInstallWorkspaceCombobox value="wt-1" onValueChange={vi.fn()} choices={sampleChoices} />
    )

    const trigger = screen.getByRole('combobox')
    expect(trigger).toHaveTextContent('orca-main · Git worktree')
  })

  it('is disabled when choices are empty', () => {
    render(<SkillInstallWorkspaceCombobox value="" onValueChange={vi.fn()} choices={[]} />)

    const trigger = screen.getByRole('combobox')
    expect(trigger).toBeDisabled()
  })

  it('opens and displays all choices on click', () => {
    render(
      <SkillInstallWorkspaceCombobox value="" onValueChange={vi.fn()} choices={sampleChoices} />
    )

    const trigger = screen.getByRole('combobox')
    fireEvent.click(trigger)

    expect(screen.getByPlaceholderText('Search workspaces...')).toBeInTheDocument()
    expect(screen.getByText('orca-main ·')).toBeInTheDocument()
    expect(screen.getByText('feature-skills ·')).toBeInTheDocument()
    expect(screen.getByText('dotfiles ·')).toBeInTheDocument()
    expect(screen.getByText('scripts-repo ·')).toBeInTheDocument()
  })

  it('filters choices by workspace label', () => {
    render(
      <SkillInstallWorkspaceCombobox value="" onValueChange={vi.fn()} choices={sampleChoices} />
    )

    fireEvent.click(screen.getByRole('combobox'))
    const searchInput = screen.getByPlaceholderText('Search workspaces...')

    fireEvent.change(searchInput, { target: { value: 'feature' } })

    expect(screen.getByText('feature-skills ·')).toBeInTheDocument()
    expect(screen.queryByText('orca-main ·')).toBeNull()
    expect(screen.queryByText('dotfiles ·')).toBeNull()
    expect(screen.queryByText('scripts-repo ·')).toBeNull()
  })

  it('filters choices by workspace kind (folder vs worktree)', () => {
    render(
      <SkillInstallWorkspaceCombobox value="" onValueChange={vi.fn()} choices={sampleChoices} />
    )

    fireEvent.click(screen.getByRole('combobox'))
    const searchInput = screen.getByPlaceholderText('Search workspaces...')

    fireEvent.change(searchInput, { target: { value: 'folder' } })

    expect(screen.getByText('dotfiles ·')).toBeInTheDocument()
    expect(screen.getByText('scripts-repo ·')).toBeInTheDocument()
    expect(screen.queryByText('orca-main ·')).toBeNull()
    expect(screen.queryByText('feature-skills ·')).toBeNull()
  })

  it('shows empty state when no choices match search query', () => {
    render(
      <SkillInstallWorkspaceCombobox value="" onValueChange={vi.fn()} choices={sampleChoices} />
    )

    fireEvent.click(screen.getByRole('combobox'))
    const searchInput = screen.getByPlaceholderText('Search workspaces...')

    fireEvent.change(searchInput, { target: { value: 'nonexistent-workspace' } })

    expect(screen.getByText('No workspaces found.')).toBeInTheDocument()
  })

  it('calls onValueChange and closes popover when an item is selected', () => {
    const onValueChange = vi.fn()
    render(
      <SkillInstallWorkspaceCombobox
        value=""
        onValueChange={onValueChange}
        choices={sampleChoices}
      />
    )

    fireEvent.click(screen.getByRole('combobox'))
    fireEvent.click(screen.getByText('feature-skills ·'))

    expect(onValueChange).toHaveBeenCalledWith('wt-2')
  })

  it('opens popover on ArrowDown key down on trigger', () => {
    render(
      <SkillInstallWorkspaceCombobox value="" onValueChange={vi.fn()} choices={sampleChoices} />
    )

    const trigger = screen.getByRole('combobox')
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })

    expect(screen.getByPlaceholderText('Search workspaces...')).toBeInTheDocument()
  })

  it('opens popover and seeds query on typing alphanumeric character on trigger', () => {
    render(
      <SkillInstallWorkspaceCombobox value="" onValueChange={vi.fn()} choices={sampleChoices} />
    )

    const trigger = screen.getByRole('combobox')
    fireEvent.keyDown(trigger, { key: 'd' })

    expect(screen.getByPlaceholderText('Search workspaces...')).toBeInTheDocument()
    const searchInput = screen.getByPlaceholderText('Search workspaces...') as HTMLInputElement
    expect(searchInput.value).toBe('d')
    expect(screen.getByText('dotfiles ·')).toBeInTheDocument()
    expect(screen.queryByText('orca-main ·')).toBeNull()
  })

  it('includes full name in title attribute for trigger when selected', () => {
    render(
      <SkillInstallWorkspaceCombobox value="wt-1" onValueChange={vi.fn()} choices={sampleChoices} />
    )

    const trigger = screen.getByRole('combobox')
    expect(trigger).toHaveAttribute('title', 'orca-main · Git worktree')
  })

  it('includes full name in title attribute for dropdown items', () => {
    render(
      <SkillInstallWorkspaceCombobox value="" onValueChange={vi.fn()} choices={sampleChoices} />
    )

    fireEvent.click(screen.getByRole('combobox'))

    const item = screen.getByTitle('feature-skills · Git worktree')
    expect(item).toBeInTheDocument()
    expect(item).toHaveTextContent('feature-skills · Git worktree')
  })
})

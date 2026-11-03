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
})

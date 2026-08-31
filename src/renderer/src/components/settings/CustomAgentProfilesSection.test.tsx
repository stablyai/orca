// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getAgentCatalog } from '@/lib/agent-catalog'
import { TooltipProvider } from '@/components/ui/tooltip'
import { CustomAgentProfilesSection } from './CustomAgentProfilesSection'
import type { ReactNode } from 'react'

vi.mock('@/components/confirmation-dialog-context', () => ({
  useConfirmationDialog: () => vi.fn().mockResolvedValue(true)
}))

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

afterEach(cleanup)

function renderWithTooltips(children: ReactNode): ReturnType<typeof render> {
  return render(<TooltipProvider>{children}</TooltipProvider>)
}

describe('CustomAgentProfilesSection', () => {
  it('creates a generic profile with ordered literal arguments', async () => {
    const user = userEvent.setup()
    const onProfilesChange = vi.fn().mockResolvedValue(undefined)
    renderWithTooltips(
      <CustomAgentProfilesSection
        profiles={[]}
        catalog={getAgentCatalog()}
        onProfilesChange={onProfilesChange}
      />
    )

    await user.click(screen.getByRole('button', { name: 'Create custom agent' }))
    await user.type(screen.getByLabelText('Name'), 'Dhimanex')
    await user.type(screen.getByLabelText('Executable'), 'dhimanex')
    await user.click(screen.getByRole('button', { name: 'Add argument' }))
    await user.type(screen.getByLabelText('Argument 1'), '--fast')
    await user.click(screen.getByRole('button', { name: 'Add argument' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(onProfilesChange).toHaveBeenCalledTimes(1))
    expect(onProfilesChange.mock.calls[0][0]).toEqual([
      expect.objectContaining({
        name: 'Dhimanex',
        executable: 'dhimanex',
        args: ['--fast', '']
      })
    ])
  })

  it('rejects a built-in display name', async () => {
    const user = userEvent.setup()
    renderWithTooltips(
      <CustomAgentProfilesSection
        profiles={[]}
        catalog={getAgentCatalog()}
        onProfilesChange={vi.fn()}
      />
    )

    await user.click(screen.getByRole('button', { name: 'Create custom agent' }))
    await user.type(screen.getByLabelText('Name'), 'Codex')
    await user.type(screen.getByLabelText('Executable'), 'codex')

    expect(
      screen.getByText('Choose a name that is not already used by another agent.')
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('drops duplicated identity when the executable changes', async () => {
    const user = userEvent.setup()
    const onProfilesChange = vi.fn().mockResolvedValue(undefined)
    renderWithTooltips(
      <CustomAgentProfilesSection
        profiles={[
          {
            id: 'codex-luna',
            name: 'Codex Luna',
            baseAgent: 'codex',
            baseAgentExecutable: 'codex',
            executable: 'codex',
            args: ['--model', 'luna']
          }
        ]}
        catalog={getAgentCatalog()}
        onProfilesChange={onProfilesChange}
      />
    )

    await user.click(screen.getByRole('button', { name: 'Edit Codex Luna' }))
    await user.clear(screen.getByLabelText('Executable'))
    await user.type(screen.getByLabelText('Executable'), 'claude')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(onProfilesChange).toHaveBeenCalledTimes(1))
    expect(onProfilesChange).toHaveBeenCalledWith([
      { id: 'codex-luna', name: 'Codex Luna', executable: 'claude', args: ['--model', 'luna'] }
    ])
  })

  it('keeps a failed checked write visible in the editor', async () => {
    const user = userEvent.setup()
    renderWithTooltips(
      <CustomAgentProfilesSection
        profiles={[]}
        catalog={getAgentCatalog()}
        onProfilesChange={vi.fn().mockRejectedValue(new Error('Settings write failed'))}
      />
    )

    await user.click(screen.getByRole('button', { name: 'Create custom agent' }))
    await user.type(screen.getByLabelText('Name'), 'Dhimanex')
    await user.type(screen.getByLabelText('Executable'), 'dhimanex')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Settings write failed')
    expect(screen.getByLabelText('Name')).toHaveValue('Dhimanex')
  })

  it('clears a failed write when the editor is cancelled', async () => {
    const user = userEvent.setup()
    renderWithTooltips(
      <CustomAgentProfilesSection
        profiles={[]}
        catalog={getAgentCatalog()}
        onProfilesChange={vi.fn().mockRejectedValue(new Error('Settings write failed'))}
      />
    )

    await user.click(screen.getByRole('button', { name: 'Create custom agent' }))
    await user.type(screen.getByLabelText('Name'), 'Dhimanex')
    await user.type(screen.getByLabelText('Executable'), 'dhimanex')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Settings write failed')

    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('clears a failed delete when the deletion is retried', async () => {
    const user = userEvent.setup()
    const onProfilesChange = vi
      .fn()
      .mockRejectedValueOnce(new Error('Settings write failed'))
      .mockResolvedValueOnce(undefined)
    renderWithTooltips(
      <CustomAgentProfilesSection
        profiles={[{ id: 'a', name: 'Agent A', executable: 'a', args: [] }]}
        catalog={getAgentCatalog()}
        onProfilesChange={onProfilesChange}
      />
    )

    const deleteAgent = screen.getByRole('button', { name: 'Delete Agent A' })
    await user.click(deleteAgent)
    expect(await screen.findByRole('alert')).toHaveTextContent('Settings write failed')

    await user.click(deleteAgent)

    await waitFor(() => expect(onProfilesChange).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('serializes deletes so stale profile lists cannot restore another deletion', async () => {
    let finishWrite: (() => void) | undefined
    const onProfilesChange = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishWrite = resolve
        })
    )
    renderWithTooltips(
      <CustomAgentProfilesSection
        profiles={[
          { id: 'a', name: 'Agent A', executable: 'a', args: [] },
          { id: 'b', name: 'Agent B', executable: 'b', args: [] }
        ]}
        catalog={getAgentCatalog()}
        onProfilesChange={onProfilesChange}
      />
    )

    const deleteA = screen.getByRole('button', { name: 'Delete Agent A' })
    const deleteB = screen.getByRole('button', { name: 'Delete Agent B' })
    fireEvent.click(deleteA)
    fireEvent.click(deleteB)

    await waitFor(() => expect(onProfilesChange).toHaveBeenCalledTimes(1))
    expect(onProfilesChange).toHaveBeenCalledWith([expect.objectContaining({ id: 'b' })])
    finishWrite?.()
    await waitFor(() => expect(deleteA).not.toBeDisabled())
  })
})

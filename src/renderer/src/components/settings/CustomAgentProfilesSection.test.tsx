// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getAgentCatalog } from '@/lib/agent-catalog'
import { TooltipProvider } from '@/components/ui/tooltip'
import { CustomAgentProfilesSection } from './CustomAgentProfilesSection'
import type { ComponentProps, ReactNode } from 'react'

vi.mock('@/components/confirmation-dialog-context', () => ({
  useConfirmationDialog: () => vi.fn().mockResolvedValue(true)
}))

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

afterEach(cleanup)

function renderWithTooltips(children: ReactNode): ReturnType<typeof render> {
  return render(<TooltipProvider>{children}</TooltipProvider>)
}

type SectionProps = Pick<
  ComponentProps<typeof CustomAgentProfilesSection>,
  'profiles' | 'onProfilesChange'
>

function renderSection(props: Partial<SectionProps> = {}): ReturnType<typeof render> {
  return renderWithTooltips(
    <CustomAgentProfilesSection
      profiles={props.profiles ?? []}
      catalog={getAgentCatalog()}
      onProfilesChange={props.onProfilesChange ?? vi.fn()}
    />
  )
}

describe('CustomAgentProfilesSection', () => {
  it('uses the installed-agent row controls and expands editing in place', async () => {
    const user = userEvent.setup()
    renderSection({
      profiles: [
        {
          id: 'codex-luna',
          name: 'Codex Luna',
          executable: 'codex',
          args: ['--model', 'luna']
        }
      ]
    })

    expect(screen.getByRole('radiogroup', { name: 'Codex Luna availability' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Set default' })).toBeVisible()

    await user.click(screen.getByRole('button', { name: 'Edit Codex Luna' }))
    expect(screen.getByLabelText('Name')).toHaveValue('Codex Luna')

    await user.click(screen.getByRole('button', { name: 'Close Codex Luna editor' }))
    expect(screen.queryByLabelText('Name')).toBeNull()
  })

  it('sets a custom default and clears it when the profile is disabled', async () => {
    const user = userEvent.setup()
    const onProfilesChange = vi.fn().mockResolvedValue(undefined)
    const profile = {
      id: 'codex-luna',
      name: 'Codex Luna',
      executable: 'codex',
      args: ['--model', 'luna']
    } as const
    const view = renderSection({ profiles: [profile], onProfilesChange })

    await user.click(screen.getByRole('button', { name: 'Set default' }))
    await waitFor(() =>
      expect(onProfilesChange).toHaveBeenCalledWith([{ ...profile, isDefault: true }])
    )

    view.rerender(
      <TooltipProvider>
        <CustomAgentProfilesSection
          profiles={[{ ...profile, isDefault: true }]}
          catalog={getAgentCatalog()}
          onProfilesChange={onProfilesChange}
        />
      </TooltipProvider>
    )
    await user.click(screen.getByRole('radio', { name: 'Disabled' }))
    await waitFor(() =>
      expect(onProfilesChange).toHaveBeenLastCalledWith([{ ...profile, enabled: false }])
    )
  })

  it('creates a generic profile with ordered literal arguments', async () => {
    const user = userEvent.setup()
    const onProfilesChange = vi.fn().mockResolvedValue(undefined)
    renderSection({ onProfilesChange })

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
    renderSection()

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
    renderSection({
      profiles: [
        {
          id: 'codex-luna',
          name: 'Codex Luna',
          baseAgent: 'codex',
          baseAgentExecutable: 'codex',
          executable: 'codex',
          args: ['--model', 'luna']
        }
      ],
      onProfilesChange
    })

    await user.click(screen.getByRole('button', { name: 'Edit Codex Luna' }))
    await user.clear(screen.getByLabelText('Executable'))
    await user.type(screen.getByLabelText('Executable'), 'claude')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(onProfilesChange).toHaveBeenCalledTimes(1))
    expect(onProfilesChange).toHaveBeenCalledWith([
      { id: 'codex-luna', name: 'Codex Luna', executable: 'claude', args: ['--model', 'luna'] }
    ])
  })

  it('keeps a failed write visible until the editor is cancelled', async () => {
    const user = userEvent.setup()
    renderSection({
      onProfilesChange: vi.fn().mockRejectedValue(new Error('Settings write failed'))
    })

    await user.click(screen.getByRole('button', { name: 'Create custom agent' }))
    await user.type(screen.getByLabelText('Name'), 'Dhimanex')
    await user.type(screen.getByLabelText('Executable'), 'dhimanex')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Settings write failed')
    expect(screen.getByLabelText('Name')).toHaveValue('Dhimanex')

    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('clears a failed delete when the deletion is retried', async () => {
    const user = userEvent.setup()
    const onProfilesChange = vi
      .fn()
      .mockRejectedValueOnce(new Error('Settings write failed'))
      .mockResolvedValueOnce(undefined)
    renderSection({
      profiles: [{ id: 'a', name: 'Agent A', executable: 'a', args: [] }],
      onProfilesChange
    })

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
    renderSection({
      profiles: [
        { id: 'a', name: 'Agent A', executable: 'a', args: [] },
        { id: 'b', name: 'Agent B', executable: 'b', args: [] }
      ],
      onProfilesChange
    })

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

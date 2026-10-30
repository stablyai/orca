import { beforeEach, describe, expect, it, vi } from 'vitest'

const warning = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { warning } }))

const { showWorktreeCreateWarningToast } = await import('./worktree-create-warning-toast')

describe('showWorktreeCreateWarningToast', () => {
  beforeEach(() => warning.mockReset())

  it('names the stopped WSL distro instead of the raw hold code', () => {
    showWorktreeCreateWarningToast(
      'Failed to create the startup terminal for /wt: terminal_held_wsl_distro_stopped:Ubuntu'
    )

    expect(warning).toHaveBeenCalledWith(
      "Failed to create the startup terminal for /wt: The WSL distro Ubuntu is stopped, so Orca didn't start this terminal. Start the distro, then try again."
    )
  })

  it('shows nothing without a warning', () => {
    showWorktreeCreateWarningToast(undefined)
    expect(warning).not.toHaveBeenCalled()
  })
})

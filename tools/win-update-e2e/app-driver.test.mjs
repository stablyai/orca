import { describe, expect, it, vi } from 'vitest'
import { dismissOverlays, ensureTerminal } from './app-driver.mjs'
import { buildFreshProfile } from './onboarding-profile.mjs'

function hiddenButton() {
  return {
    first: () => hiddenButton(),
    isVisible: vi.fn().mockResolvedValue(false),
    click: vi.fn()
  }
}

describe('dismissOverlays', () => {
  it('dismisses a dialog without clicking the desktop window Close button', async () => {
    const dialogClose = {
      first: vi.fn(),
      isVisible: vi.fn().mockResolvedValue(true),
      click: vi.fn().mockResolvedValue(undefined)
    }
    dialogClose.first.mockReturnValue(dialogClose)
    const windowClose = {
      first: vi.fn(),
      isVisible: vi.fn().mockResolvedValue(true),
      click: vi.fn().mockRejectedValue(new Error('window closed'))
    }
    windowClose.first.mockReturnValue(windowClose)
    const featureTipDialog = {
      first: vi.fn(),
      isVisible: vi.fn().mockResolvedValue(true),
      locator: vi.fn().mockReturnValue(dialogClose)
    }
    featureTipDialog.first.mockReturnValue(featureTipDialog)

    const page = {
      getByRole: vi.fn((role, { name }) => {
        if (role === 'dialog') {
          return featureTipDialog
        }
        return name === 'Close' ? windowClose : hiddenButton()
      }),
      keyboard: { press: vi.fn().mockResolvedValue(undefined) },
      waitForTimeout: vi.fn().mockResolvedValue(undefined)
    }

    await dismissOverlays(page, 1)

    expect(dialogClose.click).toHaveBeenCalledOnce()
    expect(windowClose.click).not.toHaveBeenCalled()
    expect(page.getByRole).toHaveBeenCalledWith('dialog', {
      name: 'Let agents drive Orca with the Orca CLI'
    })
  })

  it('keeps overlay retries within the caller timeout budget', async () => {
    vi.useFakeTimers()
    try {
      const newWorkspace = {
        first: vi.fn(),
        click: vi.fn(async ({ timeout }) => {
          await vi.advanceTimersByTimeAsync(timeout)
          throw new Error('button remained blocked')
        })
      }
      newWorkspace.first.mockReturnValue(newWorkspace)
      const page = {
        locator: vi.fn().mockImplementation(() => hiddenButton()),
        getByRole: vi.fn((role, { name }) => {
          if (role === 'dialog') {
            return hiddenButton()
          }
          return name === 'New workspace' ? newWorkspace : hiddenButton()
        }),
        keyboard: { press: vi.fn().mockResolvedValue(undefined) },
        isClosed: vi.fn().mockReturnValue(false)
      }

      await expect(ensureTerminal(page, { timeoutMs: 12_000 })).rejects.toThrow(
        'button remained blocked'
      )

      expect(newWorkspace.click.mock.calls.map(([options]) => options.timeout)).toEqual([
        5_000, 5_000, 2_000, 1
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds a blocked create submission by the remaining budget after a fast first click', async () => {
    vi.useFakeTimers()
    try {
      const newWorkspace = {
        first: vi.fn(),
        click: vi.fn().mockResolvedValue(undefined)
      }
      newWorkspace.first.mockReturnValue(newWorkspace)
      const createWorktree = {
        last: vi.fn(),
        click: vi.fn(async ({ timeout }) => {
          await vi.advanceTimersByTimeAsync(timeout)
          throw new Error('submit remained blocked')
        })
      }
      createWorktree.last.mockReturnValue(createWorktree)
      const composer = {
        last: vi.fn(),
        waitFor: vi.fn().mockResolvedValue(undefined),
        getByRole: vi.fn().mockReturnValue(createWorktree)
      }
      composer.last.mockReturnValue(composer)
      const xterm = {
        first: vi.fn(),
        waitFor: vi.fn().mockResolvedValue(undefined)
      }
      xterm.first.mockReturnValue(xterm)
      const terminalSurface = {
        first: vi.fn(),
        isVisible: vi.fn().mockResolvedValue(false),
        waitFor: vi.fn().mockResolvedValue(undefined),
        locator: vi.fn().mockReturnValue(xterm)
      }
      terminalSurface.first.mockReturnValue(terminalSurface)
      const page = {
        locator: vi.fn().mockImplementation(() => terminalSurface),
        getByRole: vi.fn((role, { name }) => {
          if (role === 'dialog') {
            return name === 'Create worktree' ? composer : hiddenButton()
          }
          return name === 'New workspace' ? newWorkspace : hiddenButton()
        }),
        keyboard: { press: vi.fn().mockResolvedValue(undefined) },
        isClosed: vi.fn().mockReturnValue(false)
      }

      await ensureTerminal(page, { timeoutMs: 12_000 })

      // First click is instant, so the create retry must spend only the remaining
      // 12s (last window shrinks to 2s) — not a fresh fixed 15s — then fall back.
      expect(createWorktree.click.mock.calls.map(([options]) => options.timeout)).toEqual([
        5_000, 5_000, 2_000
      ])
      expect(page.keyboard.press).toHaveBeenCalledWith('Control+Enter')
    } finally {
      vi.useRealTimers()
    }
  })

  it('dismisses the CLI tip without sending Escape into an already-restored terminal', async () => {
    const dialogClose = {
      first: vi.fn(),
      isVisible: vi.fn().mockResolvedValue(true),
      click: vi.fn().mockResolvedValue(undefined)
    }
    dialogClose.first.mockReturnValue(dialogClose)
    const featureTipDialog = {
      first: vi.fn(),
      isVisible: vi.fn().mockResolvedValue(true),
      locator: vi.fn().mockReturnValue(dialogClose)
    }
    featureTipDialog.first.mockReturnValue(featureTipDialog)
    const xterm = {
      first: vi.fn(),
      waitFor: vi.fn().mockResolvedValue(undefined)
    }
    xterm.first.mockReturnValue(xterm)
    const terminalSurface = {
      first: vi.fn(),
      isVisible: vi.fn().mockResolvedValue(true),
      waitFor: vi.fn().mockResolvedValue(undefined),
      locator: vi.fn().mockReturnValue(xterm)
    }
    terminalSurface.first.mockReturnValue(terminalSurface)
    const page = {
      locator: vi.fn().mockReturnValue(terminalSurface),
      getByRole: vi.fn((role) => (role === 'dialog' ? featureTipDialog : hiddenButton())),
      keyboard: { press: vi.fn().mockResolvedValue(undefined) }
    }

    await ensureTerminal(page, { allowCreate: false })

    expect(dialogClose.click).toHaveBeenCalledOnce()
    expect(page.keyboard.press).not.toHaveBeenCalled()
  })

  it('submits within the composer without dismissing and reopening it', async () => {
    const newWorkspace = {
      first: vi.fn(),
      click: vi.fn().mockResolvedValue(undefined)
    }
    newWorkspace.first.mockReturnValue(newWorkspace)
    const createWorktree = {
      last: vi.fn(),
      click: vi
        .fn()
        .mockRejectedValueOnce(new Error('submit was briefly intercepted'))
        .mockResolvedValueOnce(undefined)
    }
    createWorktree.last.mockReturnValue(createWorktree)
    const composer = {
      last: vi.fn(),
      waitFor: vi.fn().mockResolvedValue(undefined),
      getByRole: vi.fn().mockReturnValue(createWorktree)
    }
    composer.last.mockReturnValue(composer)
    const xterm = {
      first: vi.fn(),
      waitFor: vi.fn().mockResolvedValue(undefined)
    }
    xterm.first.mockReturnValue(xterm)
    const terminalSurface = {
      first: vi.fn(),
      isVisible: vi.fn().mockResolvedValue(false),
      waitFor: vi.fn().mockResolvedValue(undefined),
      locator: vi.fn().mockReturnValue(xterm)
    }
    terminalSurface.first.mockReturnValue(terminalSurface)
    const unintendedDialogClose = {
      first: vi.fn(),
      isVisible: vi.fn().mockResolvedValue(true),
      click: vi.fn().mockResolvedValue(undefined)
    }
    unintendedDialogClose.first.mockReturnValue(unintendedDialogClose)
    const page = {
      locator: vi.fn((selector) =>
        selector.includes('dialog-close') ? unintendedDialogClose : terminalSurface
      ),
      getByRole: vi.fn((role, { name }) => {
        if (role === 'dialog') {
          return name === 'Create worktree' ? composer : hiddenButton()
        }
        return name === 'New workspace' ? newWorkspace : hiddenButton()
      }),
      keyboard: { press: vi.fn().mockResolvedValue(undefined) },
      isClosed: vi.fn().mockReturnValue(false)
    }

    await ensureTerminal(page)

    expect(composer.getByRole).toHaveBeenCalledWith('button', { name: /^Create worktree/ })
    expect(unintendedDialogClose.click).not.toHaveBeenCalled()
    expect(createWorktree.click).toHaveBeenCalledTimes(2)
  })

  it('pins fresh harness profiles to a blank terminal', () => {
    expect(buildFreshProfile().settings.defaultTuiAgent).toBe('blank')
  })
})

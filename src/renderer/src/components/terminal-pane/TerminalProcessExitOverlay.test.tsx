// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TerminalProcessExitOverlay } from './TerminalProcessExitOverlay'

describe('TerminalProcessExitOverlay', () => {
  afterEach(cleanup)

  it('explains the Git Bash limit and exposes recovery actions', () => {
    const onRestart = vi.fn()
    const onClose = vi.fn()
    render(
      <TerminalProcessExitOverlay
        processExit={{
          paneId: 1,
          exitCode: 1,
          reason: 'git-bash-console-capacity',
          startup: null
        }}
        onRestart={onRestart}
        onClose={onClose}
      />
    )

    expect(screen.getByRole('alert').textContent).toContain('128-console limit')
    fireEvent.click(screen.getByRole('button', { name: 'Restart' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))

    expect(onRestart).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('preserves the exit code for other shell failures', () => {
    render(
      <TerminalProcessExitOverlay
        processExit={{ paneId: 1, exitCode: 7, reason: 'process-failed', startup: null }}
        onRestart={vi.fn()}
        onClose={vi.fn()}
      />
    )

    expect(screen.getByRole('alert').textContent).toContain('exit code 7')
  })
})

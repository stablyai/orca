// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  useRepositoryAddScriptResultStore,
  type RepositoryAddScriptResultView
} from '@/store/repository-add-script-result'
import { RepositoryAddScriptResultDialog } from './RepositoryAddScriptResultDialog'

function show(overrides: Partial<RepositoryAddScriptResultView> = {}): void {
  const result: RepositoryAddScriptResultView = {
    status: 'failed',
    path: '/work/projects/my-repo',
    hostLabel: 'Build box',
    output: 'failed output',
    outputTruncated: false,
    ...overrides
  }
  act(() => {
    useRepositoryAddScriptResultStore.getState().showRepositoryAddScriptResult(result)
  })
}

function footerClose(): HTMLElement {
  // The footer button comes before the dialog's own close control in the DOM.
  const [button] = screen.getAllByRole('button', { name: 'Close' })
  if (!button) {
    throw new Error('expected a close button')
  }
  return button
}

function dialogClose(): HTMLElement {
  const buttons = screen.getAllByRole('button', { name: 'Close' })
  const button = buttons.at(-1)
  if (!button || buttons.length < 2) {
    throw new Error('expected the dialog close control')
  }
  return button
}

beforeEach(() => {
  act(() => {
    // Reset directly: the dismiss guard would otherwise stop this drain mid-window.
    useRepositoryAddScriptResultStore.setState({
      result: null,
      queued: [],
      dismissAllowedAt: 0
    })
  })
})

afterEach(() => {
  cleanup()
})

describe('RepositoryAddScriptResultDialog', () => {
  it('shows a failure with its real exit code and output', () => {
    show({ exitCode: 3, output: 'boom from the script' })
    render(<RepositoryAddScriptResultDialog />)

    expect(screen.getByText('Add script failed')).toBeInTheDocument()
    expect(screen.getByText('Exit code 3')).toBeInTheDocument()
    expect(screen.getByText('boom from the script')).toBeInTheDocument()
  })

  it('says no exit code was recorded and never invents a success code', () => {
    show({ output: 'killed' })
    render(<RepositoryAddScriptResultDialog />)

    expect(screen.getByText('No exit code was recorded.')).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('Exit code 0')
  })

  it('describes an execution failure without an exit code section', () => {
    show({ reason: 'execution-failed', output: '' })
    render(<RepositoryAddScriptResultDialog />)

    expect(
      screen.getByText('Orca could not start the add script for my-repo on Build box.')
    ).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('Exit code')
    expect(document.body.textContent).not.toContain('No exit code was recorded.')
  })

  it('presents an unverifiable stop as possibly still running, not as a failure', () => {
    show({ status: 'unverifiable', output: 'partial output' })
    render(<RepositoryAddScriptResultDialog />)

    expect(screen.getByText('Add script may still be running')).toBeInTheDocument()
    expect(screen.getByText(/could not confirm that it stopped/)).toBeInTheDocument()
    expect(screen.getByText(/It may still be running/)).toBeInTheDocument()
    expect(screen.queryByText('Add script failed')).toBeNull()
  })

  it('marks truncated output', () => {
    show({ outputTruncated: true })
    render(<RepositoryAddScriptResultDialog />)

    expect(
      screen.getByText('Output was truncated; earlier lines are not shown.')
    ).toBeInTheDocument()
  })

  it('says no output was recorded instead of rendering an empty block', () => {
    show({ output: '' })
    render(<RepositoryAddScriptResultDialog />)

    expect(screen.getByText('No output was recorded.')).toBeInTheDocument()
    expect(document.querySelector('pre')).toBeNull()
  })

  it('shows queued failures one at a time and keeps each result intact', async () => {
    const user = userEvent.setup()
    show({ exitCode: 1, output: 'first failure', path: '/work/projects/first-repo' })
    show({ exitCode: 7, output: 'second failure', path: '/work/projects/second-repo' })
    render(<RepositoryAddScriptResultDialog />)

    expect(screen.getByText('Exit code 1')).toBeInTheDocument()
    expect(screen.getByText('first failure')).toBeInTheDocument()
    expect(screen.queryByText('second failure')).toBeNull()

    await user.click(footerClose())

    expect(useRepositoryAddScriptResultStore.getState().result?.exitCode).toBe(7)
    expect(screen.getByText('Exit code 7')).toBeInTheDocument()
    expect(screen.getByText('second failure')).toBeInTheDocument()
    expect(screen.queryByText('first failure')).toBeNull()

    // The close guard spans one gesture; wait it out before dismissing the next result.
    await new Promise((resolve) => setTimeout(resolve, 400))
    await user.click(footerClose())

    expect(useRepositoryAddScriptResultStore.getState().result).toBeNull()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('does not let a double click dismiss the next unread result', async () => {
    const user = userEvent.setup()
    show({ exitCode: 1, output: 'first failure' })
    show({ exitCode: 7, output: 'second failure' })
    show({ exitCode: 9, output: 'third failure' })
    render(<RepositoryAddScriptResultDialog />)

    await user.click(footerClose())

    expect(screen.getByText('Exit code 7')).toBeInTheDocument()
    expect(useRepositoryAddScriptResultStore.getState().queued).toHaveLength(1)

    // Same tick: the second click of a double click lands on the result just revealed.
    fireEvent.click(footerClose())

    const guarded = useRepositoryAddScriptResultStore.getState()
    expect(guarded.result?.exitCode).toBe(7)
    expect(guarded.queued).toHaveLength(1)
    expect(screen.getByText('Exit code 7')).toBeInTheDocument()

    await new Promise((resolve) => setTimeout(resolve, 400))
    await user.click(footerClose())

    expect(useRepositoryAddScriptResultStore.getState().result?.exitCode).toBe(9)
    expect(screen.getByText('Exit code 9')).toBeInTheDocument()
  })

  it('clears the result when the footer button closes the dialog', async () => {
    const user = userEvent.setup()
    show()
    render(<RepositoryAddScriptResultDialog />)

    await user.click(footerClose())

    expect(useRepositoryAddScriptResultStore.getState().result).toBeNull()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('clears the result when the dialog close control dismisses it', async () => {
    const user = userEvent.setup()
    show()
    render(<RepositoryAddScriptResultDialog />)

    await user.click(dialogClose())

    expect(useRepositoryAddScriptResultStore.getState().result).toBeNull()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
})

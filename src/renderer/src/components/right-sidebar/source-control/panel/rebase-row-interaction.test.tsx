// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { shouldShowSourceControlBranchContextChrome } from './branch-context-stats'
import {
  createFakeRebaseRepo,
  installFakeRebaseGit,
  RebaseRowInteractionHarness,
  type FakeRebaseRepoState
} from './rebase-row-interaction.test-fixture'

afterEach(cleanup)

let worktreeCounter = 0

function renderRow(initial: Partial<FakeRebaseRepoState> = {}) {
  const repo = createFakeRebaseRepo(initial)
  installFakeRebaseGit(repo)
  worktreeCounter += 1
  render(
    <TooltipProvider>
      <RebaseRowInteractionHarness repo={repo} worktreeId={`wt-interaction-${worktreeCounter}`} />
    </TooltipProvider>
  )
  return { repo, user: userEvent.setup() }
}

function statusText(): string {
  return screen.getByRole('status').textContent ?? ''
}

function description(element: HTMLElement): string {
  const id = element.getAttribute('aria-describedby')
  return (id && document.getElementById(id)?.textContent) || ''
}

function stepActions(repo: ReturnType<typeof createFakeRebaseRepo>) {
  return repo.calls.map((call) => call.action)
}

describe('Source Control rebase row, driven by clicks and keys', () => {
  it('runs Rebase, waits on conflicts, keeps focus on Continue, and finishes', async () => {
    const { repo, user } = renderRow()

    await user.click(screen.getByRole('button', { name: 'Rebase onto origin/main' }))
    await waitFor(() => expect(statusText()).toBe('Rebase paused · 2 conflicts'))

    const step = await screen.findByRole('button', { name: 'Continue' })
    expect(step.getAttribute('aria-disabled')).toBe('true')
    expect(description(step)).toBe('Resolve conflicts first')
    // An unavailable Continue is clickable for focus and its reason, but runs nothing.
    await user.click(step)
    expect(stepActions(repo)).toEqual(['inspect'])

    // Keyboard: Abort then the step button, each one tab stop.
    step.blur()
    await user.tab()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Abort rebase' }))
    await user.tab()
    expect(document.activeElement).toBe(step)

    // Resolving under focus turns the same button available; focus does not drop to the body.
    repo.resolveOneConflict()
    repo.resolveOneConflict()
    await waitFor(() => expect(step.getAttribute('aria-disabled')).toBeNull())
    expect(document.activeElement).toBe(step)
    expect(description(step)).toBe('')

    await user.keyboard('{Enter}')
    await waitFor(() => expect(statusText()).toBe('Rebase paused · 1 conflict'))
    expect(repo.calls.at(-2)).toMatchObject({ action: 'continue', expected: { step: '1' } })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Continue' }))

    repo.resolveOneConflict()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Continue' }).getAttribute('aria-disabled')).toBe(
        null
      )
    )
    await user.keyboard('{Enter}')
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
    expect(screen.getByText('Up to date')).toBeTruthy()
  })

  it('says why when the automatic step check fails, and Retry reads it again', async () => {
    const { repo, user } = renderRow({ paused: true, step: 1, head: 'h1', inspectFailuresLeft: 1 })

    const retry = await screen.findByRole('button', { name: 'Retry checking the rebase step' })
    expect(statusText()).toBe("Rebase paused · Couldn't check step")
    expect(description(retry)).toBe(
      "Couldn't check this rebase step: WSL distro Ubuntu is not running"
    )
    expect(retry.getAttribute('aria-disabled')).toBeNull()

    await user.click(retry)
    // The same button becomes Continue once the stop is read, so keyboard focus survives the retry.
    await waitFor(() => expect(retry.textContent).toBe('Continue'))
    expect(document.activeElement).toBe(retry)
    expect(stepActions(repo)).toEqual(['inspect', 'inspect'])

    await user.click(retry)
    await waitFor(() => expect(statusText()).toBe('Rebase paused · 1 conflict'))
    expect(repo.calls.at(-2)).toMatchObject({ action: 'continue', expected: { step: '1' } })
  })

  it('offers Skip on an empty step and skips only the stop it showed', async () => {
    const { repo, user } = renderRow({ paused: true, step: 1, head: 'h1', emptyStep: true })

    await user.click(await screen.findByRole('button', { name: 'Continue' }))
    const skip = await screen.findByRole('button', { name: 'Skip this rebase step' })
    expect(statusText()).toBe('Rebase paused · Empty step')
    expect(description(skip)).toBe('Nothing to commit in this step. Skip drops it and moves on.')

    await user.click(skip)
    await waitFor(() => expect(statusText()).toBe('Rebase paused · 1 conflict'))
    expect(stepActions(repo)).toEqual(['inspect', 'continue', 'skip', 'inspect'])
    expect(repo.calls[2]).toMatchObject({ expected: { head: 'h1', step: '1' } })
  })

  it('asks before Abort, and aborts only on confirm', async () => {
    const { repo, user } = renderRow({ paused: true, step: 1, head: 'h1', unresolved: 2 })

    await user.click(await screen.findByRole('button', { name: 'Abort rebase' }))
    let dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(stepActions(repo)).not.toContain('abort')

    await user.click(screen.getByRole('button', { name: 'Abort rebase' }))
    dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Abort rebase' }))
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
    expect(stepActions(repo)).toContain('abort')
    expect(screen.getByRole('button', { name: 'Rebase onto origin/main' })).toBeTruthy()
  })
})

it('shows the paused strip even with no head identity and no compare base', () => {
  expect(shouldShowSourceControlBranchContextChrome(null, null, null)).toBe(false)
  expect(shouldShowSourceControlBranchContextChrome(null, null, null, true)).toBe(true)
})

// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RepositoryAddScriptPreview } from '../../../../shared/repository-add-script-types'
import {
  offerRepositoryAddScript,
  takeRepositoryAddScriptPrompt,
  useRepositoryAddScriptPromptStore,
  type RepositoryAddScriptPromptResolver
} from '@/store/repository-add-script-prompt'
import { RepositoryAddScriptPromptDialog } from './RepositoryAddScriptPromptDialog'

function preview(overrides: Partial<RepositoryAddScriptPreview> = {}): RepositoryAddScriptPreview {
  return {
    token: 'token-1',
    hostId: 'local',
    hostLabel: 'Build box',
    repoId: 'repo-1',
    path: '/work/projects/my-repo',
    target: { kind: 'native', cwd: '/work/projects/my-repo' },
    script: 'pnpm install --frozen-lockfile',
    scriptHash: 'hash-1',
    ...overrides
  }
}

function offer(
  candidate: RepositoryAddScriptPreview,
  resolver: RepositoryAddScriptPromptResolver
): void {
  act(() => {
    offerRepositoryAddScript(candidate, resolver)
  })
}

/** Leaves the singleton queue empty and past its guard so each test starts clean. */
async function drainPrompts(): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (takeRepositoryAddScriptPrompt('skip')) {
      continue
    }
    if (useRepositoryAddScriptPromptStore.getState().current === null) {
      // Why: every take arms the 350ms guard, so the next test's first click must clear it.
      await new Promise((resolve) => setTimeout(resolve, 360))
      return
    }
    // Why: the queue guards the freshly revealed prompt for 350ms.
    await new Promise((resolve) => setTimeout(resolve, 360))
  }
  throw new Error('prompt queue did not drain')
}

beforeEach(async () => {
  await drainPrompts()
})

afterEach(() => {
  cleanup()
})

describe('RepositoryAddScriptPromptDialog', () => {
  it('names the repo, host, script and target directory', () => {
    offer(preview(), vi.fn())
    render(<RepositoryAddScriptPromptDialog />)

    expect(screen.getByText('Run add script for my-repo?')).toBeInTheDocument()
    expect(screen.getAllByText(/Build box/).length).toBeGreaterThan(0)
    expect(screen.getByText('pnpm install --frozen-lockfile').tagName).toBe('PRE')
    expect(
      screen.getByText(
        (content) => content.startsWith('Runs in ') && content.includes('/work/projects/my-repo')
      )
    ).toBeInTheDocument()
  })

  it('decides to run exactly once and closes', async () => {
    const user = userEvent.setup()
    const resolver = vi.fn()
    const offered = preview()
    offer(offered, resolver)
    render(<RepositoryAddScriptPromptDialog />)

    await user.click(screen.getByRole('button', { name: 'Run' }))

    expect(resolver).toHaveBeenCalledTimes(1)
    expect(resolver).toHaveBeenCalledWith('run', offered)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('decides to skip exactly once and closes', async () => {
    const user = userEvent.setup()
    const resolver = vi.fn()
    const offered = preview()
    offer(offered, resolver)
    render(<RepositoryAddScriptPromptDialog />)

    await user.click(screen.getByRole('button', { name: 'Skip' }))

    expect(resolver).toHaveBeenCalledTimes(1)
    expect(resolver).toHaveBeenCalledWith('skip', offered)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('treats Escape as a skip, never a run', async () => {
    const user = userEvent.setup()
    const resolver = vi.fn()
    const offered = preview()
    offer(offered, resolver)
    render(<RepositoryAddScriptPromptDialog />)

    await user.keyboard('{Escape}')

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(resolver).toHaveBeenCalledTimes(1)
    expect(resolver).toHaveBeenCalledWith('skip', offered)
    expect(resolver).not.toHaveBeenCalledWith('run', offered)
  })

  it('treats the close button as a skip, never a run', async () => {
    const user = userEvent.setup()
    const resolver = vi.fn()
    const offered = preview()
    offer(offered, resolver)
    render(<RepositoryAddScriptPromptDialog />)

    await user.click(screen.getByRole('button', { name: 'Close' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(resolver).toHaveBeenCalledTimes(1)
    expect(resolver).toHaveBeenCalledWith('skip', offered)
    expect(resolver).not.toHaveBeenCalledWith('run', offered)
  })

  it('reveals the queued prompt as soon as the first one decides', async () => {
    const user = userEvent.setup()
    const first = vi.fn()
    const second = vi.fn()
    offer(preview(), first)
    offer(
      preview({
        token: 'token-2',
        repoId: 'repo-2',
        path: '/work/other-repo',
        target: { kind: 'native', cwd: '/work/other-repo' }
      }),
      second
    )
    render(<RepositoryAddScriptPromptDialog />)

    await user.click(screen.getByRole('button', { name: 'Skip' }))

    expect(first).toHaveBeenCalledTimes(1)
    expect(first).toHaveBeenCalledWith('skip', expect.objectContaining({ token: 'token-1' }))
    expect(second).not.toHaveBeenCalled()
    expect(screen.getByText('Run add script for other-repo?')).toBeInTheDocument()
  })

  it('ignores a second action that lands inside the inter-prompt guard', async () => {
    const first = vi.fn()
    const second = vi.fn()
    offer(preview(), first)
    offer(
      preview({
        token: 'token-2',
        repoId: 'repo-2',
        path: '/work/other-repo',
        target: { kind: 'native', cwd: '/work/other-repo' }
      }),
      second
    )
    render(<RepositoryAddScriptPromptDialog />)

    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))

    expect(first).toHaveBeenCalledTimes(1)
    expect(first).toHaveBeenCalledWith('run', expect.objectContaining({ token: 'token-1' }))
    expect(second).not.toHaveBeenCalled()
    expect(screen.getByText('Run add script for other-repo?')).toBeInTheDocument()

    await new Promise((resolve) => setTimeout(resolve, 400))
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))

    expect(second).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledWith('run', expect.objectContaining({ token: 'token-2' }))
  })

  it('does not let a double click run a prompt that filled the emptied slot', async () => {
    const user = userEvent.setup()
    const first = vi.fn()
    const second = vi.fn()
    offer(preview(), first)
    render(<RepositoryAddScriptPromptDialog />)

    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    // A registration finishes while the dialog closes and takes the emptied slot.
    offer(
      preview({
        token: 'token-2',
        repoId: 'repo-2',
        path: '/work/other-repo',
        target: { kind: 'native', cwd: '/work/other-repo' }
      }),
      second
    )
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))

    expect(first).toHaveBeenCalledTimes(1)
    expect(second).not.toHaveBeenCalled()
    expect(screen.getByText('Run add script for other-repo?')).toBeInTheDocument()

    await new Promise((resolve) => setTimeout(resolve, 400))
    await user.click(screen.getByRole('button', { name: 'Run' }))
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('renders nothing while no prompt is offered', () => {
    render(<RepositoryAddScriptPromptDialog />)

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.body.textContent).toBe('')
  })
})

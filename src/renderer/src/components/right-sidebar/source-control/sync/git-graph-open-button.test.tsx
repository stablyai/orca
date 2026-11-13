// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'

const mocks = vi.hoisted(() => ({
  support: true as boolean | null,
  openGitGraph: vi.fn()
}))

vi.mock('@/i18n/i18n', () => ({
  getIntlLocale: () => 'en-US',
  translate: (_key: string, fallback: string) => fallback
}))
vi.mock('../panel/worktree-scope', () => ({
  useSourceControlState: <T,>(selector: (state: unknown) => T) => selector({})
}))
vi.mock('@/lib/source-control/graph/git-graph-tab', () => ({
  gitGraphScope: () => undefined,
  gitGraphSupport: () => mocks.support,
  probeGitGraphSupport: async () => mocks.support,
  gitGraphUpdateMessage: () => 'Update Orca on build-box to open the Git Graph',
  openGitGraph: mocks.openGitGraph
}))

import { GitGraphOpenButton } from './git-graph-open-button'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderButton(): HTMLButtonElement {
  render(
    <TooltipProvider>
      <GitGraphOpenButton worktreeId="wt-1" />
    </TooltipProvider>
  )
  return screen.getByRole('button', { name: 'Graph' }) as HTMLButtonElement
}

describe('GitGraphOpenButton', () => {
  it('opens Git Graph from a labeled button when the host supports it', async () => {
    mocks.support = true
    const button = renderButton()
    await waitFor(() => expect(button.disabled).toBe(false))
    fireEvent.click(button)
    expect(mocks.openGitGraph).toHaveBeenCalledWith('wt-1')
  })

  it('stays disabled with the update explanation on a host without Git Graph', async () => {
    mocks.support = false
    const button = renderButton()
    expect(button.disabled).toBe(true)
    fireEvent.focus(button.parentElement!)
    expect(
      await screen.findAllByText('Update Orca on build-box to open the Git Graph')
    ).not.toEqual([])
  })
})

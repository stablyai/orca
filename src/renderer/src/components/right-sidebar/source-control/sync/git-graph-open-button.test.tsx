// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'

const mocks = vi.hoisted(() => ({
  support: true,
  openGitGraph: vi.fn(),
  probes: 0
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
  probeGitGraphSupport: async () => {
    mocks.probes += 1
    return mocks.support
  },
  gitGraphUpdateMessage: () => 'Update Orca on build-box to open the Git Graph',
  openGitGraph: mocks.openGitGraph
}))

import { GitGraphOpenButton, useGitGraphSupport } from './git-graph-open-button'

function PanelGraphButton({ buttonShown = true }: { buttonShown?: boolean }) {
  const support = useGitGraphSupport('wt-1')
  return buttonShown ? <GitGraphOpenButton worktreeId="wt-1" support={support} /> : null
}

afterEach(() => {
  mocks.probes = 0
  cleanup()
  vi.clearAllMocks()
})

function renderButton(): HTMLButtonElement {
  render(
    <TooltipProvider>
      <PanelGraphButton />
    </TooltipProvider>
  )
  return screen.getByRole<HTMLButtonElement>('button', { name: 'Graph' })
}

describe('GitGraphOpenButton', () => {
  it('opens Git Graph from a labeled button when the host supports it', async () => {
    mocks.support = true
    const button = renderButton()
    await waitFor(() => expect(button.disabled).toBe(false))
    fireEvent.click(button)
    expect(mocks.openGitGraph).toHaveBeenCalledWith('wt-1')
  })

  it('does not open Git Graph on a host without support', () => {
    mocks.support = false
    const button = renderButton()
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(mocks.openGitGraph).not.toHaveBeenCalled()
  })

  it('probes once for a supported host', async () => {
    mocks.support = true
    const button = renderButton()
    await waitFor(() => expect(button.disabled).toBe(false))
    expect(mocks.probes).toBe(1)
  })

  it('rechecks support when the button returns while the host was unsupported', async () => {
    mocks.support = false
    const view = render(
      <TooltipProvider>
        <PanelGraphButton />
      </TooltipProvider>
    )
    await waitFor(() => expect(mocks.probes).toBe(1))
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Graph' }).disabled).toBe(true)

    // The filter row hides the button; meanwhile the host is updated with no owner or status change.
    view.rerender(
      <TooltipProvider>
        <PanelGraphButton buttonShown={false} />
      </TooltipProvider>
    )
    mocks.support = true
    view.rerender(
      <TooltipProvider>
        <PanelGraphButton />
      </TooltipProvider>
    )
    const button = screen.getByRole<HTMLButtonElement>('button', { name: 'Graph' })
    await waitFor(() => expect(button.disabled).toBe(false))
  })
})

// @vitest-environment happy-dom

import { act } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/types'
import { getDefaultSettings } from '../../../../shared/constants'
import { ExperimentalPane } from './ExperimentalPane'
import { getExperimentalPaneSearchEntries } from './experimental-search'

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: { settingsSearchQuery: string }) => unknown) =>
    selector({ settingsSearchQuery: '' })
}))

afterEach(() => {
  document.body.innerHTML = ''
})

async function renderExperimentalPane(args: {
  updateSettings: (settings: Partial<GlobalSettings>) => void
  settings?: GlobalSettings
}): Promise<{ root: Root; container: HTMLDivElement }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      <ExperimentalPane
        settings={args.settings ?? getDefaultSettings('/tmp')}
        updateSettings={args.updateSettings}
      />
    )
  })
  return { root, container }
}

describe('ExperimentalPane', () => {
  it('does not render compact worktree cards after graduation from Experimental', () => {
    const markup = renderToStaticMarkup(
      <ExperimentalPane settings={getDefaultSettings('/tmp')} updateSettings={vi.fn()} />
    )

    expect(markup).not.toContain('Compact worktree cards')
    expect(getExperimentalPaneSearchEntries().map((entry) => entry.title)).not.toContain(
      'Compact worktree cards'
    )
  })

  it('renders agent hibernation as an off-by-default searchable experimental switch', () => {
    const settings = getDefaultSettings('/tmp')
    const markup = renderToStaticMarkup(
      <ExperimentalPane settings={settings} updateSettings={vi.fn()} />
    )

    expect(settings.experimentalAgentHibernation).toBe(false)
    expect(settings.agentHibernationIdleMs).toBe(30 * 60 * 1000)
    expect(markup).toContain('Agent hibernation')
    expect(markup).not.toContain('Hibernate after')
    expect(markup).toContain('aria-checked="false"')
    expect(getExperimentalPaneSearchEntries().map((entry) => entry.title)).toContain(
      'Agent hibernation'
    )
  })

  it('renders new card style as an off-by-default searchable experimental switch', () => {
    const settings = getDefaultSettings('/tmp')
    const markup = renderToStaticMarkup(
      <ExperimentalPane settings={settings} updateSettings={vi.fn()} />
    )

    expect(settings.experimentalNewWorktreeCardStyle).toBe(false)
    expect(markup).toContain('New card style')
    expect(markup).toContain('aria-checked="false"')
    expect(getExperimentalPaneSearchEntries().map((entry) => entry.title)).toContain(
      'New card style'
    )
  })

  it('renders the agent hibernation idle duration as configurable minutes', async () => {
    const updateSettings = vi.fn()
    const settings = {
      ...getDefaultSettings('/tmp'),
      experimentalAgentHibernation: true
    }
    const { root, container } = await renderExperimentalPane({ updateSettings, settings })

    const idleInput = container.querySelector<HTMLInputElement>(
      '#experimental-agent-hibernation input[type="number"]'
    )
    if (!idleInput) {
      throw new Error('Agent hibernation duration input was not rendered')
    }

    expect(idleInput.value).toBe('30')
    expect(idleInput.min).toBe('1')
    expect(idleInput.max).toBe('1440')
    expect(idleInput.step).toBe('1')
    expect(container.textContent).toContain('How many idle minutes')
    expect(container.textContent).toContain('minutes')
    root.unmount()
  })

  it('enables agent hibernation through the experimental switch', async () => {
    const updateSettings = vi.fn()
    const { root, container } = await renderExperimentalPane({ updateSettings })

    const switchButton = container.querySelector<HTMLButtonElement>(
      '#experimental-agent-hibernation button[role="switch"]'
    )
    if (!switchButton) {
      throw new Error('Agent hibernation switch was not rendered')
    }

    await act(async () => {
      switchButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(updateSettings).toHaveBeenCalledWith({ experimentalAgentHibernation: true })
    root.unmount()
  })

  it('enables new card style through the experimental switch', async () => {
    const updateSettings = vi.fn()
    const { root, container } = await renderExperimentalPane({ updateSettings })

    const switchButton = container.querySelector<HTMLButtonElement>(
      '#experimental-new-worktree-card-style button[role="switch"]'
    )
    if (!switchButton) {
      throw new Error('New card style switch was not rendered')
    }

    await act(async () => {
      switchButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(updateSettings).toHaveBeenCalledWith({ experimentalNewWorktreeCardStyle: true })
    root.unmount()
  })
})

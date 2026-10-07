// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { AgentsPane } from './AgentsPane'
import { TooltipProvider } from '../ui/tooltip'

const detected = vi.hoisted(() => {
  const state: { ids: string[] | null; failed: boolean } = {
    ids: ['claude', 'codex', 'goose'],
    failed: false
  }
  return state
})

vi.mock('@/hooks/useDetectedAgents', () => ({
  useDetectedAgents: () => ({
    detectedIds: detected.ids,
    isLoading: detected.ids === null && !detected.failed,
    detectionFailed: detected.failed,
    isRefreshing: false,
    refresh: vi.fn()
  })
}))

beforeEach(() => {
  detected.ids = ['claude', 'codex', 'goose']
  detected.failed = false
})
afterEach(cleanup)

function pane(overrides: Partial<GlobalSettings>): React.JSX.Element {
  return (
    <TooltipProvider>
      <AgentsPane
        settings={{ ...getDefaultSettings('/tmp'), agentPermissionMode: 'bypass', ...overrides }}
        updateSettings={vi.fn()}
      />
    </TooltipProvider>
  )
}

function renderPane(overrides: Partial<GlobalSettings>): ReturnType<typeof render> {
  return render(pane(overrides))
}

/** The line under the Agent Permissions switch that names the agents it won't move. */
function permissionLine(): HTMLElement {
  const line = Array.from(document.querySelectorAll('span')).find(
    (element) => element.firstChild?.textContent === "These agents don't follow this switch:"
  )
  if (!line) {
    throw new Error('No permissions line')
  }
  return line
}

function row(agent: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-agent-row="${agent}"]`)
  if (!element) {
    throw new Error(`No row for ${agent}`)
  }
  return element
}

async function collapse(agent: string): Promise<void> {
  await userEvent.click(
    within(row(agent)).getByRole('button', { name: 'Collapse command override' })
  )
}

describe('Agent Permissions line', () => {
  it('says why each agent does not follow the switch', () => {
    detected.ids = ['claude', 'codex', 'goose']
    renderPane({
      agentPermissionModeOverrides: { claude: 'ask' },
      agentDefaultArgs: { codex: '-a on-request' },
      agentDefaultEnv: { goose: { GOOSE_MODE: 'approve' } }
    })

    const text = permissionLine().textContent
    expect(text).toContain('Claude runs Manual: it has its own setting.')
    expect(text).toContain('Codex runs Manual: its Arguments set -a on-request.')
    expect(text).toContain('Goose runs Manual: its environment sets GOOSE_MODE=approve.')
    expect(document.body.textContent).not.toContain('Set separately')
  })

  // Arguments decide the launch, so they are the reason even beside the agent's own choice.
  it('gives Arguments as the reason when an agent also has its own setting', () => {
    renderPane({
      agentPermissionModeOverrides: { codex: 'bypass' },
      agentDefaultArgs: { codex: '-a on-request' }
    })

    expect(permissionLine().textContent).toContain(
      'Codex runs Manual: its Arguments set -a on-request.'
    )
  })

  it('names an agent that is not installed here but has its own setting', () => {
    detected.ids = ['claude']
    renderPane({ agentPermissionModeOverrides: { codex: 'ask' } })

    expect(permissionLine().textContent).toContain('Codex runs Manual: it has its own setting.')
  })

  it('states the rule once, in the description, with no tooltip', () => {
    renderPane({})

    expect(document.body.textContent).toContain(
      'Applies to every agent without its own setting in the list below.'
    )
    expect(document.querySelector('[aria-label="Agent permissions info"]')).toBeNull()
  })

  it('no longer repeats the Arguments reason in a warning on the agent card', () => {
    renderPane({ agentDefaultArgs: { codex: '-a on-request' } })

    expect(within(row('codex')).getByRole('radiogroup', { name: 'Codex permissions' })).toBeTruthy()
    expect(document.body.textContent).not.toContain('set permissions themselves')
    expect(row('codex').querySelector('.text-status-warning')).toBeNull()
  })
})

describe('Agent Permissions line links', () => {
  it('opens an agent with its own setting and focuses its Permissions choice', async () => {
    renderPane({ agentPermissionModeOverrides: { claude: 'ask' } })
    await collapse('claude')
    expect(
      within(row('claude')).queryByRole('radiogroup', { name: 'Claude permissions' })
    ).toBeNull()

    await userEvent.click(within(permissionLine()).getByRole('button', { name: 'Claude' }))

    const group = within(row('claude')).getByRole('radiogroup', { name: 'Claude permissions' })
    expect(document.activeElement).toBe(within(group).getByRole('radio', { name: 'Manual' }))
  })

  it('opens an agent whose Arguments decide and focuses its Arguments field', async () => {
    renderPane({ agentDefaultArgs: { codex: '-a on-request' } })
    await collapse('codex')

    await userEvent.click(within(permissionLine()).getByRole('button', { name: 'Codex' }))

    expect(document.activeElement).toBeInstanceOf(HTMLInputElement)
    expect(document.activeElement).toHaveValue('-a on-request')
    expect(row('codex').contains(document.activeElement)).toBe(true)
  })

  it('opens an agent whose environment decides and focuses its environment field', async () => {
    renderPane({ agentDefaultEnv: { goose: { GOOSE_MODE: 'approve' } } })
    await collapse('goose')

    await userEvent.click(within(permissionLine()).getByRole('button', { name: 'Goose' }))

    expect(document.activeElement).toHaveValue('GOOSE_MODE=approve')
    expect(row('goose').contains(document.activeElement)).toBe(true)
  })

  it('focuses the Permissions choice of an agent that is not installed here', async () => {
    detected.ids = ['claude']
    renderPane({ agentPermissionModeOverrides: { codex: 'ask' } })

    await userEvent.click(within(permissionLine()).getByRole('button', { name: 'Codex' }))

    const group = within(row('codex')).getByRole('radiogroup', { name: 'Codex permissions' })
    expect(document.activeElement).toBe(within(group).getByRole('radio', { name: 'Manual' }))
  })

  it('works from the keyboard with Enter and Space, and shows a focus ring', async () => {
    renderPane({ agentPermissionModeOverrides: { claude: 'ask' } })
    const link = within(permissionLine()).getByRole('button', { name: 'Claude' })
    expect(link.className).toContain('focus-visible:ring')
    const manual = (): HTMLElement =>
      within(
        within(row('claude')).getByRole('radiogroup', { name: 'Claude permissions' })
      ).getByRole('radio', { name: 'Manual' })

    for (const key of ['{Enter}', ' ']) {
      await collapse('claude')
      link.focus()
      await userEvent.keyboard(key)
      expect(document.activeElement).toBe(manual())
    }
  })

  // The line says Arguments decide, so the link must land on the Arguments field, installed or not.
  it('focuses the Arguments field of a not-installed agent whose Arguments decide', async () => {
    detected.ids = ['claude']
    renderPane({
      agentPermissionModeOverrides: { codex: 'bypass' },
      agentDefaultArgs: { codex: '-a on-request' }
    })
    expect(permissionLine().textContent).toContain(
      'Codex runs Manual: its Arguments set -a on-request.'
    )

    await userEvent.click(within(permissionLine()).getByRole('button', { name: 'Codex' }))

    expect(document.activeElement).toHaveValue('-a on-request')
    expect(row('codex').contains(document.activeElement)).toBe(true)
  })
})

// The landing must show its focus ring after a mouse click too; a radio's ring is :focus-visible only.
describe('Agent Permissions line focus ring', () => {
  it('asks for visible focus on the control it lands on, from the mouse and the keyboard', async () => {
    const focus = vi.spyOn(HTMLElement.prototype, 'focus')
    renderPane({ agentPermissionModeOverrides: { claude: 'ask' } })
    const link = within(permissionLine()).getByRole('button', { name: 'Claude' })
    const target = (): HTMLElement =>
      within(
        within(row('claude')).getByRole('radiogroup', { name: 'Claude permissions' })
      ).getByRole('radio', { name: 'Manual' })

    await userEvent.click(link)
    expect(focus.mock.contexts.at(-1)).toBe(target())
    expect(focus.mock.calls.at(-1)?.[0]).toMatchObject({ focusVisible: true })

    link.focus()
    await userEvent.keyboard('{Enter}')
    expect(document.activeElement).toBe(target())
    expect(focus.mock.calls.at(-1)?.[0]).toMatchObject({ focusVisible: true })
    focus.mockRestore()
  })
})

// Before detection finishes no rows render, so a name can't open anything yet.
describe('Agent Permissions line before agents are detected', () => {
  it.each([
    ['pending', false],
    ['failed', true]
  ])('shows names as plain text while detection is %s', (_state, failed) => {
    detected.ids = null
    detected.failed = failed
    renderPane({ agentPermissionModeOverrides: { claude: 'ask' } })

    expect(permissionLine().textContent).toContain('Claude runs Manual: it has its own setting.')
    expect(within(permissionLine()).queryByRole('button')).toBeNull()
  })

  it('turns names into working links once detection finishes', async () => {
    detected.ids = null
    const view = renderPane({ agentPermissionModeOverrides: { claude: 'ask' } })
    detected.ids = ['claude']
    view.rerender(pane({ agentPermissionModeOverrides: { claude: 'ask' } }))
    await collapse('claude')

    await userEvent.click(within(permissionLine()).getByRole('button', { name: 'Claude' }))

    const group = within(row('claude')).getByRole('radiogroup', { name: 'Claude permissions' })
    expect(document.activeElement).toBe(within(group).getByRole('radio', { name: 'Manual' }))
  })
})

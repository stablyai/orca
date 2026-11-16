// @vitest-environment happy-dom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent, getByRole, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AgentLaunchPicker } from './AgentLaunchPicker'
import type { NewTabAgentMenuModel } from './launch-menu/new-tab-agent-menu-model'
import type {
  AgentPickerDraft,
  AgentPickerEntry
} from '../../../../shared/agent-launch/picker/agent-launch-picker'
vi.mock('@/hooks/useShortcutLabel', () => ({ useOptionalShortcutLabel: () => null }))

const efforts = [
  { value: 'low', label: 'Low' },
  { value: 'high', label: 'High' }
]
function entry(agent: 'codex' | 'claude', label: string): AgentPickerEntry {
  return {
    agent,
    label,
    rows: [{ agent, kind: 'cli' }],
    surfaces: ['terminal'],
    defaultSurface: 'terminal',
    terminal: {},
    structured: {},
    arguments: '',
    catalog: {
      origin: 'probe',
      fetchedAt: 1,
      models: [
        { id: `${agent}-a`, label: `${label} A`, isDefault: true, efforts },
        { id: `${agent}-b`, label: `${label} B`, isDefault: false, efforts }
      ]
    }
  }
}
const entries = [entry('codex', 'Codex'), entry('claude', 'Claude')]
const model: NewTabAgentMenuModel = {
  state: 'settled',
  rows: entries.flatMap((row) => row.rows),
  detection: {
    detectedIds: entries.map((row) => row.agent),
    isLoading: false,
    isRefreshing: false,
    detectionFailed: false,
    needsServerUpdate: false,
    refresh: async () => entries.map((row) => row.agent)
  }
}
const picks = vi.fn()
const blank = vi.fn()

/** A settings form: it keeps the picked setup and derives each agent's draft from it. */
function Form() {
  const [saved, setSaved] = useState<AgentPickerDraft>({
    agent: 'codex',
    surface: 'terminal',
    choices: {},
    arguments: '--saved'
  })
  return (
    <TooltipProvider>
      <AgentLaunchPicker
        model={model}
        entries={entries}
        agent={saved.agent}
        launchDefaults
        draftForEntry={(row) =>
          row.agent === saved.agent ? saved : { agent: row.agent, surface: 'terminal', choices: {} }
        }
        onSelectBlankTerminal={blank}
        onPick={(agent, draft) => {
          picks(agent, draft)
          if (draft) {
            setSaved(draft)
          }
        }}
      />
    </TooltipProvider>
  )
}

let root: Root
let host: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  picks.mockClear()
  blank.mockClear()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root.render(<Form />))
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

const trigger = () => getByRole(document.body, 'button', { name: 'Select agent' })
const search = () => document.querySelector<HTMLInputElement>('[cmdk-input]')
const args = () => getByRole(document.body, 'textbox', { name: 'Arguments' })
const open = async () => {
  await userEvent.setup().click(trigger())
  await waitFor(() => expect(search()).not.toBeNull())
}

it('starts a reopened picker from the setup the fields saved after an earlier pick', async () => {
  await open()
  fireEvent.click(getByRole(document.body, 'radio', { name: 'High' }))
  expect(picks.mock.lastCall?.[1]?.choices.options?.effort).toBe('high')
  fireEvent.keyDown(search()!, { key: 'Escape' })
  await waitFor(() => expect(search()).toBeNull())
  fireEvent.change(args(), { target: { value: '--saved --verbose' } })
  fireEvent.blur(args())
  await waitFor(() => expect(picks.mock.lastCall?.[1]?.arguments).toContain('--verbose'))
  await open()
  fireEvent.click(getByRole(document.body, 'option', { name: 'Codex B' }))
  expect(picks.mock.lastCall?.[1]?.choices.model).toBe('codex-b')
  expect(picks.mock.lastCall?.[1]?.arguments).toContain('--verbose')
})

it('removes a chip from the Arguments text being typed, not the saved text', async () => {
  await open()
  fireEvent.click(getByRole(document.body, 'option', { name: 'Codex B' }))
  await waitFor(() => expect(search()).toBeNull())
  fireEvent.change(args(), { target: { value: '--saved --verbose' } })
  fireEvent.click(getByRole(document.body, 'button', { name: 'Remove -m codex-b' }))
  expect(picks.mock.lastCall?.[1]?.choices.model).toBeUndefined()
  expect(picks.mock.lastCall?.[1]?.arguments).toContain('--verbose')
})

it('reaches the rows under the card from search and from the keyboard', async () => {
  const user = userEvent.setup()
  await open()
  await user.keyboard('blank')
  await user.keyboard('{Enter}')
  expect(blank).toHaveBeenCalledOnce()
  await open()
  await user.keyboard('{ArrowDown}{ArrowDown}')
  expect(document.activeElement?.textContent).toBe('Blank Terminal')
  await user.keyboard('{ArrowUp}')
  expect(document.activeElement).toBe(search())
})

it('moves between the agent tabs with the keyboard', async () => {
  const user = userEvent.setup()
  await open()
  await user.keyboard('{Shift>}{Tab}{/Shift}')
  expect(document.activeElement).toBe(getByRole(document.body, 'tab', { name: 'Codex' }))
  await user.keyboard('{ArrowRight}')
  expect(document.activeElement).toBe(getByRole(document.body, 'tab', { name: 'Claude' }))
  await user.keyboard('{Enter}')
  await waitFor(() => expect(search()?.placeholder).toBe('Search Claude models…'))
  await user.keyboard('{Shift>}{Tab}{/Shift}{ArrowDown}')
  expect(document.activeElement).toBe(search())
})

it('names the model in the closed trigger before its host listing has loaded', () => {
  const claude: AgentPickerEntry = { ...entry('claude', 'Claude'), catalog: { origin: 'unknown' } }
  act(() =>
    root.render(
      <AgentLaunchPicker
        model={model}
        entries={[claude]}
        agent="claude"
        cli
        value={{ agent: 'claude', surface: 'terminal', choices: { model: 'claude-opus-5-5' } }}
        onPick={picks}
      />
    )
  )
  expect(trigger().textContent).toBe('Claude (CLI) · Claude Opus 5.5')
})

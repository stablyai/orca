// @vitest-environment happy-dom
import { act } from 'react'
import { fireEvent } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  agentPickerDraft,
  type AgentPickerEntry
} from '../../../../shared/agent-launch/picker/agent-launch-picker'
import { entry, root } from './agent-launch-setup-panel-test-fixture'
import { AgentLaunchSetupPanel } from './AgentLaunchSetupPanel'

const opencode: AgentPickerEntry = {
  ...entry,
  agent: 'opencode',
  label: 'OpenCode',
  rows: [{ agent: 'opencode', kind: 'cli', executionHostId: 'local' }],
  arguments: '--model opencode/gpt-5.3-codex',
  terminal: {},
  catalog: { origin: 'unknown' }
}
const listed: AgentPickerEntry = {
  ...opencode,
  catalog: {
    origin: 'probe',
    fetchedAt: 1,
    models: [
      'github-copilot/claude-fable-5',
      'github-copilot/claude-opus-5',
      'opencode/gpt-5.3-codex'
    ].map((id) => ({ id, label: id, efforts: [], isDefault: false }))
  }
}
const draft = agentPickerDraft(opencode)
const onUse = vi.fn(() => true)
const onDraftChange = vi.fn()
const render = (own: AgentPickerEntry, mode?: 'select') =>
  act(() =>
    root.render(
      <TooltipProvider>
        <AgentLaunchSetupPanel
          entry={own}
          mode={mode}
          draft={draft}
          getDraft={() => draft}
          onDraftChange={onDraftChange}
          onUse={onUse}
        />
      </TooltipProvider>
    )
  )
const highlighted = () =>
  document.querySelector('[cmdk-item][data-selected="true"]')?.getAttribute('data-value')

it('opens on the current model, not the first listed one', () => {
  render(listed)
  expect(highlighted()).toBe('opencode/gpt-5.3-codex')
})

it('keeps the current model highlighted when the catalog arrives and lists it', () => {
  render(opencode)
  expect(highlighted()).toBe('opencode/gpt-5.3-codex')
  render(listed)
  expect(highlighted()).toBe('opencode/gpt-5.3-codex')
})

it('starts on the resolved model when defaults settle after the panel opens', () => {
  render({ ...listed, arguments: undefined, defaultsPending: true })
  render(listed)
  expect(highlighted()).toBe('opencode/gpt-5.3-codex')
})

it('keeps an Arguments-owned text action on its default instead of the inherited model', () => {
  render(
    {
      ...listed,
      arguments: '',
      terminal: { model: 'opencode/gpt-5.3-codex' },
      textGeneration: {
        defaultLabel: 'Default',
        modelInArguments: true,
        effortInArguments: false,
        modelArgumentsUnrecognized: false,
        effortArgumentsUnrecognized: false,
        effortInModel: false,
        effortByModel: {}
      }
    },
    'select'
  )
  expect(highlighted()).toBe('__text_action_default__')
})

it('returns to the current model after a search is cleared, so Enter uses it', () => {
  render(listed, 'select')
  const search = document.querySelector<HTMLInputElement>('[cmdk-input]')!
  fireEvent.change(search, { target: { value: 'opus' } })
  expect(highlighted()).toBe('github-copilot/claude-opus-5')
  fireEvent.change(search, { target: { value: '' } })
  expect(highlighted()).toBe('opencode/gpt-5.3-codex')
  onUse.mockClear()
  onDraftChange.mockClear()
  fireEvent.keyDown(search, { key: 'Enter' })
  expect(onUse).toHaveBeenCalledTimes(1)
  expect(onDraftChange).not.toHaveBeenCalled()
})

// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AgentLaunchSetupPanel } from './AgentLaunchSetupPanel'
import type {
  AgentPickerDraft,
  AgentPickerEntry
} from '../../../../shared/agent-launch/picker/agent-launch-picker'

afterEach(cleanup)

const model = (id: string) => ({ id, label: id, isDefault: false, efforts: [] })
const ENTRY: AgentPickerEntry = {
  agent: 'antigravity',
  label: 'Antigravity',
  rows: [{ kind: 'cli', agent: 'antigravity', chat: true }],
  surfaces: ['chat', 'terminal'],
  defaultSurface: 'chat',
  terminal: {},
  structured: {},
  catalog: { origin: 'probe', fetchedAt: 1, models: [model('gemini-4-neon'), model('gpt-oss')] },
  catalogRead: 'settled',
  ownerKey: 'refresh-keys'
}
const DRAFT: AgentPickerDraft = {
  agent: 'antigravity',
  surface: 'chat',
  choices: { model: 'gemini-4-neon' }
}

it('Enter on the focused Refresh button refreshes instead of using the highlighted current model', () => {
  const onUse = vi.fn()
  render(
    <TooltipProvider>
      <AgentLaunchSetupPanel
        entry={ENTRY}
        draft={DRAFT}
        getDraft={() => DRAFT}
        onDraftChange={() => {}}
        onUse={onUse}
      />
    </TooltipProvider>
  )
  expect(document.querySelector('[cmdk-item][data-selected="true"][data-current="true"]')).not.toBe(
    null
  )
  const refresh = screen.getByRole('button', { name: 'Refresh models' })
  refresh.focus()
  fireEvent.keyDown(refresh, { key: 'Enter' })
  expect(onUse).not.toHaveBeenCalled()
  // Refreshing: the button spins and waits for the listing.
  expect(refresh).toHaveProperty('disabled', true)
})

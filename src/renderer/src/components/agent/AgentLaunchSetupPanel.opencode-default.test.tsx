// @vitest-environment happy-dom
import { entry, host, root, onUse } from './agent-launch-setup-panel-test-fixture'
import { act } from 'react'
import { expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AgentLaunchSetupPanel } from './AgentLaunchSetupPanel'
import type { AgentPickerEntry } from '../../../../shared/agent-launch-picker'
import { parseOpenCodeModelListing } from '../../../../main/opencode/opencode-model-catalog-listing'
import recordedOpenCodeListing from '../../../../main/acp/fixtures/opencode-v1-model-listing.txt?raw'

it('shows the recorded OpenCode default without choosing an effort for launch', () => {
  const models = parseOpenCodeModelListing(recordedOpenCodeListing)
  const chat: AgentPickerEntry = {
    ...entry,
    agent: 'opencode',
    defaultSurface: 'chat',
    arguments: undefined,
    structured: { model: models[0]!.id },
    catalog: { origin: 'probe', fetchedAt: 1, models }
  }
  act(() =>
    root.render(
      <TooltipProvider>
        <AgentLaunchSetupPanel entry={chat} onUse={onUse} />
      </TooltipProvider>
    )
  )
  expect(host.querySelector('[role="radio"][data-state="on"]')?.textContent).toBe('Default')
  act(() =>
    [...host.querySelectorAll('button')]
      .find((button) => button.textContent === 'Launch chat')
      ?.click()
  )
  expect(onUse).toHaveBeenCalledExactlyOnceWith({
    agent: 'opencode',
    surface: 'chat',
    choices: {},
    arguments: undefined
  })
})

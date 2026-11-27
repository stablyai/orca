import { expect, it } from 'vitest'
import { agentLaunchSetupCatalogState } from './agent-launch-setup-option-rows'
import type { AgentPickerEntry } from '../../../../shared/agent-launch/picker/agent-launch-picker'

const REFUSED: AgentPickerEntry = {
  agent: 'codex',
  label: 'Codex',
  rows: [],
  surfaces: ['chat', 'terminal'],
  defaultSurface: 'chat',
  terminal: { options: {} },
  structured: { options: {} },
  catalog: { origin: 'unknown', unavailable: { reason: 'agentCommandNotRunnable' } },
  catalogRead: 'settled'
}

it('only a chat is told its Command is not a runnable program, with no Retry', () => {
  const chat = agentLaunchSetupCatalogState(REFUSED, [], undefined, 'chat')
  expect(chat.catalogMessage).toMatch(/^Codex's Command in Settings → Agents must start/)
  expect(chat.catalogRetryable).toBe(false)
  const terminal = agentLaunchSetupCatalogState(REFUSED, [], undefined, 'terminal')
  expect(terminal.catalogMessage).toBe('Codex models have not loaded.')
  expect(terminal.catalogRetryable).toBe(true)
})

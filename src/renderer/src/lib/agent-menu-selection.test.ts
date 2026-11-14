import { expect, it } from 'vitest'
import { resolveAgentMenuSelection } from './agent-menu-selection'

const input = {
  agent: 'zcode',
  settings: { agentDefaultSurface: 'terminal' },
  executionHostId: 'local',
  inventoryReady: true,
  answer: 'yes',
  chatPending: false,
  plain: false
} as const

it('keeps an explicitly picked chat on the structured route when terminal is the default', () => {
  expect(resolveAgentMenuSelection({ ...input, surface: 'chat' })).toMatchObject({
    ready: true,
    choice: {
      agent: 'zcode',
      route: 'structured-native-chat',
      requestedSurface: 'chat'
    }
  })
})

it('keeps an explicitly picked terminal on the terminal route', () => {
  expect(
    resolveAgentMenuSelection({
      ...input,
      settings: { agentDefaultSurface: 'chat' },
      surface: 'terminal'
    })
  ).toMatchObject({
    ready: true,
    choice: {
      agent: 'zcode',
      route: 'terminal-tui',
      requestedSurface: 'terminal'
    }
  })
})

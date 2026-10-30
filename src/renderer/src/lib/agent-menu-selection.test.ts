import { expect, it } from 'vitest'
import { resolveAgentMenuSelection } from './agent-menu-selection'

const input = {
  agent: 'zcode',
  settings: { experimentalNativeChat: false },
  executionHostId: 'local',
  inventoryReady: true,
  answer: 'yes',
  chatPending: false,
  plain: false
} as const

it('keeps an explicitly picked chat on the structured route while Chat UI is off', () => {
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
  expect(resolveAgentMenuSelection({ ...input, surface: 'terminal' })).toMatchObject({
    ready: true,
    choice: {
      agent: 'zcode',
      route: 'terminal-tui',
      requestedSurface: 'terminal'
    }
  })
})

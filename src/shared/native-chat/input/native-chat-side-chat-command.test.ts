import { expect, it } from 'vitest'
import { buildNativeChatPickerItems } from './native-chat-picker-items'
import { withNativeChatSideChatCommands } from './native-chat-side-chat-command'

it('keeps /btw in the menu behind an agent catalog longer than the menu shows', () => {
  const agentCommands = Array.from({ length: 60 }, (_, index) => ({
    name: `agent-${String(index).padStart(2, '0')}`,
    description: 'agent command'
  }))
  const commands = withNativeChatSideChatCommands(agentCommands, {
    side: 'side',
    btw: 'btw',
    argumentHint: '<question>',
    unavailableReason: null
  })

  const names = buildNativeChatPickerItems(commands, [], '', '/').map((item) => item.name)

  expect(names).toContain('btw')
  expect(names).toContain('side')
})

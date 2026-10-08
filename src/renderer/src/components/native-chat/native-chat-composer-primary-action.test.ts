import { describe, expect, it } from 'vitest'
import { nativeChatComposerPrimaryAction } from './native-chat-composer-primary-action'

describe('the composer primary action', () => {
  it.each([
    { isWorking: false, composerEmpty: true, queueHeld: true, action: 'resume' },
    { isWorking: false, composerEmpty: false, queueHeld: true, action: 'send' },
    { isWorking: false, composerEmpty: true, queueHeld: false, action: 'send' },
    { isWorking: false, composerEmpty: false, queueHeld: false, action: 'send' },
    { isWorking: true, composerEmpty: true, queueHeld: true, action: 'stop' },
    { isWorking: true, composerEmpty: false, queueHeld: false, action: 'stop' }
  ])(
    'working $isWorking, empty $composerEmpty, held $queueHeld: $action',
    ({ action, ...input }) => {
      expect(nativeChatComposerPrimaryAction(input)).toBe(action)
    }
  )
})

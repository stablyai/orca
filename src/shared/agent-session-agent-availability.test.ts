import { expect, it } from 'vitest'
import { decodeAgentSessionAvailabilityFrame } from './agent-session-agent-availability'

it('keeps an independently reported chat program on an availability row', () => {
  expect(
    decodeAgentSessionAvailabilityFrame({
      type: 'availability',
      agents: [{ agent: 'zcode', state: 'available', chatProgram: 'available' }]
    })?.get('zcode')
  ).toEqual({ agent: 'zcode', state: 'available', chatProgram: 'available' })
})

it('still reads an older host frame without a chat program', () => {
  expect(
    decodeAgentSessionAvailabilityFrame({
      type: 'availability',
      agents: [{ agent: 'zcode', state: 'available' }]
    })?.get('zcode')
  ).toEqual({ agent: 'zcode', state: 'available' })
})

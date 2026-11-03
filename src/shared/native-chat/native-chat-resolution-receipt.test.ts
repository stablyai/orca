import { expect, it } from 'vitest'
import { nativeChatReceiptDevice } from './native-chat-resolution-receipt'
import type { AgentJournalResolution } from '../agent-session/journal/agent-session-journal-types'

const resolution: AgentJournalResolution = {
  state: 'resolved',
  selectedOptionId: 'red',
  resolvedBy: '5d857d9e-ec3f-4762-b7f4-69691f580707',
  resolvedAt: 10
}
const labels = { current: 'this phone', computer: 'the computer', unknown: 'another device' }

it.each([
  [undefined, 'another device'],
  [{ kind: 'current' }, 'this phone'],
  [{ kind: 'named', name: "Kelvin's iPhone" }, "Kelvin's iPhone"],
  [{ kind: 'named', name: ' ' }, 'another device']
] satisfies [AgentJournalResolution['resolvedByDevice'], string][])(
  'uses readable receipt labels for current, named and older-host devices: %j',
  (resolvedByDevice, expected) => {
    expect(nativeChatReceiptDevice({ ...resolution, resolvedByDevice }, labels)).toBe(expected)
  }
)

it.each(['trusted-local:desktop', 'desktop-renderer'])(
  "does not display older hosts' local caller key %s",
  (resolvedBy) => {
    expect(nativeChatReceiptDevice({ ...resolution, resolvedBy }, labels)).toBe('the computer')
  }
)

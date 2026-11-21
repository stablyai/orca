import { expect, it } from 'vitest'
import { AcknowledgedWorkspaceSessionEntries } from './workspace-session-acknowledged-entries'

it('resends a keyed save whose acknowledgement raced another host being forgotten', () => {
  const acknowledged = new AcknowledgedWorkspaceSessionEntries()
  acknowledged.diff('ssh:b', { activeGroupIdByWorktree: { w: 'idle' } }).acknowledge()
  const keyed = acknowledged.diffEntries('ssh:b', { activeGroupIdByWorktree: { w: 'working' } })
  // Another host skipped the same save before ssh:b answered; ssh:b applied 'working'.
  acknowledged.forget('ssh:a')
  keyed?.acknowledge()

  // The value flips back: main holds 'working', so 'idle' must be sent.
  expect(acknowledged.diff('ssh:b', { activeGroupIdByWorktree: { w: 'idle' } }).patch).toEqual({
    fields: { activeGroupIdByWorktree: { w: 'idle' } },
    entries: {}
  })
})

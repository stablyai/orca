import { expect, it, vi } from 'vitest'
import type * as RunningAgentTargetsModule from '@/lib/agent-session/messaging/running-agent-targets'
import { holdNotesForSend, isNoteInFlight } from '@/components/notes/delivery/notes-send-in-flight'
import { createTestStore } from '../../testing/app-store-test-fixture'

const delivery = vi.hoisted(() => Promise.withResolvers<{ status: 'not-ready' }>())

vi.mock('@/lib/agent-session/messaging/running-agent-targets', async (importOriginal) => ({
  ...(await importOriginal<typeof RunningAgentTargetsModule>()),
  resolveRunningAgentSendTarget: () => ({
    kind: 'structured-session',
    paneKey: 'sample-pane',
    sessionId: 'sample-session',
    agentType: 'codex',
    status: 'eligible'
  })
}))
vi.mock('@/lib/agent-session/messaging/terminal/active-agent-note-send', () => ({}))
vi.mock('@/lib/agent-session/messaging/agent-message-send', () => ({
  sendMessageToAgent: () => delivery.promise
}))

it('holds the sidebar send before yielding to delivery and releases it on refusal', async () => {
  const store = createTestStore()
  const key = 'sample-note-snapshot'
  store.getState().openAgentSendPopoverTargetMode({
    id: 'sample-picker',
    worktreeId: 'sample-workspace',
    source: 'diff-notes',
    prompt: 'Review the sample plan.',
    label: 'Sample notes',
    launchSource: 'notes_send',
    onPromptHandedOff: (pending) => holdNotesForSend([key], pending)
  })

  const sending = store.getState().sendPromptToSidebarAgentTarget('sample-pane')
  try {
    expect(isNoteInFlight(key)).toBe(true)
  } finally {
    delivery.resolve({ status: 'not-ready' })
    await sending
  }
  expect(isNoteInFlight(key)).toBe(false)
})

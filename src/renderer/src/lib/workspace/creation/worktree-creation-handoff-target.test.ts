import { expect, it, vi } from 'vitest'

const tabs = new Map<string, Record<string, unknown>>()
vi.mock('@/store/index', () => ({
  useAppStore: { getState: () => ({ getTab: (id: string) => tabs.get(id) ?? null }) }
}))
vi.mock('@/lib/agent-session/launch/structured-agent-session-launch-registry', () => ({
  getStructuredAgentSessionLaunchOwner: () => undefined
}))

const {
  confirmWorktreeCreationHandoffTarget,
  readWorktreeCreationHandoffTarget,
  releaseFirstSendFilesWhenHeld
} = await import('./worktree-creation-handoff-target')

const chat = { id: 'tab', contentType: 'agent-session', worktreeId: 'wt' }

// The draft moves only into the chat captured before the readiness wait, if it is still that session
// on that host; a closed tab, a replaced session or a changed host keeps the input at its source.
it('confirms a handoff target only while its tab, session and host are unchanged', () => {
  tabs.set('tab', { ...chat, entityId: 'session-1', executionHostId: 'local' })
  const captured = readWorktreeCreationHandoffTarget('tab', 'wt')
  expect(captured).not.toBeNull()
  expect(confirmWorktreeCreationHandoffTarget(captured!, 'wt')?.sessionId).toBe('session-1')

  tabs.set('tab', { ...chat, entityId: 'session-2', executionHostId: 'local' })
  expect(confirmWorktreeCreationHandoffTarget(captured!, 'wt')).toBeNull()
  tabs.set('tab', { ...chat, entityId: 'session-1', executionHostId: 'remote-host' })
  expect(confirmWorktreeCreationHandoffTarget(captured!, 'wt')).toBeNull()
  tabs.delete('tab')
  expect(confirmWorktreeCreationHandoffTarget(captured!, 'wt')).toBeNull()
})

// The first send's staged files outlive an undelivered send to a chat that went stale (Retry needs
// them); they are released once the send was delivered or the draft moved into a confirmed chat.
it('releases the first send files only once a recipient holds them', async () => {
  const released = async (delivered: boolean, transferred: boolean): Promise<boolean> => {
    let release = false
    const delivery = Promise.resolve({ delivered, failureNotified: !delivered })
    releaseFirstSendFilesWhenHeld(delivery, () => transferred, { release: () => (release = true) })
    await delivery
    await Promise.resolve()
    return release
  }
  expect(await released(false, false)).toBe(false)
  expect(await released(true, false)).toBe(true)
  expect(await released(false, true)).toBe(true)
})

import { expect, it, vi } from 'vitest'

const tabs = new Map<string, Record<string, unknown>>()
vi.mock('@/store/index', () => ({
  useAppStore: { getState: () => ({ getTab: (id: string) => tabs.get(id) ?? null }) }
}))
vi.mock('@/lib/agent-session/launch/structured-agent-session-launch-registry', () => ({
  getStructuredAgentSessionLaunchOwner: () => undefined
}))

const {
  captureNativeChatStagedInput,
  hasNativeChatStagedFiles,
  moveNativeChatStagedFiles,
  reconcileNativeChatStagedDraft,
  stageNativeChatDraftFile
} = await import('@/components/native-chat/drafts/native-chat-draft-attachment-staging')
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

// The first send's staged file is released only once a holder is proven: a recorded delivery, or the
// chat it moved into still referencing it. A moved draft whose send came back refused, with an
// unavailable chip and no reference, keeps the original file readable.
it('keeps a moved first-send file until it is delivered or still referenced', async () => {
  const settle = async (
    name: string,
    delivered: boolean,
    destinationImages: { id: string; path: string }[]
  ): Promise<boolean> => {
    const source = `first-send-source-${name}`
    const destination = `first-send-destination-${name}`
    const file = `blob:first-send-${name}`
    stageNativeChatDraftFile(source, file)
    const files = captureNativeChatStagedInput(source, { text: '', attachments: [{ path: file }] })
    moveNativeChatStagedFiles(source, destination)
    reconcileNativeChatStagedDraft(destination, {
      text: '',
      images: destinationImages.map((image) => (image.path ? image : { ...image, path: file }))
    })
    reconcileNativeChatStagedDraft(destination, { text: '', images: destinationImages })
    const delivery = Promise.resolve({ delivered, failureNotified: !delivered })
    releaseFirstSendFilesWhenHeld(delivery, () => true, files)
    await delivery
    await Promise.resolve()
    return hasNativeChatStagedFiles(destination)
  }
  // Refused and handed back as an unavailable chip: still readable for the recipient or Retry.
  expect(await settle('expired', false, [{ id: 'returned', path: '' }])).toBe(true)
  // The recipient holds a real reference: the lease goes, the draft keeps the file.
  expect(
    await settle('referenced', false, [{ id: 'kept', path: 'blob:first-send-referenced' }])
  ).toBe(true)
  // Recorded delivery with no reference left: the redundant copy is released.
  expect(await settle('delivered', true, [])).toBe(false)
})

import { it, vi, expect, afterEach } from 'vitest'
import {
  createMemoryNativeChatComposerDraftStorage,
  setNativeChatComposerDraftStorageForTests
} from '@/components/native-chat/drafts/native-chat-composer-draft-storage'
import { createTestStore } from '../testing/app-store-test-fixture'
import * as drafts from '@/components/native-chat/drafts/native-chat-draft-reset'
import * as draftsOwner1 from '@/components/native-chat/drafts/native-chat-composer-draft-load'
import * as draftsOwner2 from '@/components/native-chat/drafts/native-chat-launch-draft-source'
import * as draftsOwner3 from '@/components/native-chat/drafts/native-chat-composer-draft-store'
import * as draftsOwner4 from '@/components/native-chat/drafts/native-chat-composer-draft-memory'
import * as draftsOwner5 from '@/components/native-chat/drafts/native-chat-composer-draft-removal'
import * as draftsOwner6 from '@/components/native-chat/drafts/native-chat-composer-draft-persistence'
import * as pending from '@/components/native-chat/attachments/chips/native-chat-pending-attachment-cache'

afterEach(() => vi.restoreAllMocks())

it('preserves current-memory association, replay and deletion beside ordinary hydration', async () => {
  const count = 2
  drafts.clearNativeChatComposerDraftsForTests()
  pending.clearNativeChatPendingAttachmentsForTests()
  const storage = createMemoryNativeChatComposerDraftStorage()
  const gate = Promise.withResolvers<ReadonlyMap<string, unknown>>()
  const scope = (host: string, index: number) =>
    `agent-setup:["ssh:${host}","repo::/held${index}","codex"]`
  const rich = (text: string) => ({
    text,
    images: [
      { id: 'shared', path: '/shared.png' },
      { id: text, path: `/${text}.png` }
    ],
    document: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'nativeChatSkill', attrs: { token: '$same', path: `/${text}/SKILL.md` } }
          ]
        }
      ]
    },
    savedAt: 1
  })
  for (let i = 0; i < count; i++) {
    storage.drafts.set(scope('old', i), rich(`residue${i}`))
    storage.drafts.set(scope('new', i), rich(`other-residue${i}`))
    storage.drafts.set(`agent-session:ordinary${i}`, rich(`ordinary${i}`))
  }
  const snapshot = new Map(storage.drafts)
  const write = vi.fn(storage.write),
    update = vi.fn(storage.update),
    remove = vi.fn(storage.remove)
  setNativeChatComposerDraftStorageForTests({
    ...storage,
    loadAll: () => gate.promise,
    write,
    update,
    remove
  })
  const loading = draftsOwner1.hydrateNativeChatComposerDrafts()
  const store = createTestStore()
  const control = draftsOwner2.nativeChatLaunchPromptDraftScopeKey(
    'unrelated::/live',
    'claude',
    'ssh:other'
  )
  draftsOwner3.updateNativeChatComposerDraft(control, { text: 'unrelated input' }, 'immediate')
  const untouched = vi.fn(),
    releaseControl = draftsOwner3.subscribeToNativeChatComposerDraft(control, untouched)
  const releases: (() => void)[] = []
  const notifications = vi.fn()
  const rows = Array.from({ length: count }, (_, i) => {
    const from = draftsOwner2.nativeChatLaunchPromptDraftScopeKey(
      `repo::/held${i}`,
      'codex',
      'ssh:old'
    )
    const to = draftsOwner2.nativeChatLaunchPromptDraftScopeKey(
      `repo::/held${i}`,
      'codex',
      'ssh:new'
    )
    draftsOwner3.updateNativeChatComposerDraft(from, rich(`source${i}`), 'immediate')
    draftsOwner3.updateNativeChatComposerDraft(to, rich(`target${i}`), 'immediate')
    const attempt = draftsOwner4.captureNativeChatComposerSubmission(from)
    if (i % 2 === 0) {
      draftsOwner3.updateNativeChatComposerDraft(from, { text: '', images: [] }, 'immediate')
    }
    releases.push(draftsOwner3.subscribeToNativeChatComposerDraft(from, notifications))
    releases.push(draftsOwner4.subscribeToNativeChatComposerDraftAppend(from, notifications))
    releases.push(pending.subscribeToNativeChatPendingAttachments(from, notifications))
    pending.addNativeChatPendingAttachment(from, { id: `pending${i}`, path: '', pending: true })
    return { from, to, attempt }
  })
  const event = { oldTargetId: 'old', newTargetId: 'new', repoIds: ['repo'] }
  store.getState().recordSshRepoReadoptions([event])
  expect(write).not.toHaveBeenCalled()
  expect(update).not.toHaveBeenCalled()
  expect(remove).not.toHaveBeenCalled()
  store
    .getState()
    .recordSshRepoReadoptions([{ oldTargetId: 'new', newTargetId: 'last', repoIds: ['repo'] }])
  store.getState().recordSshRepoReadoptions([{ ...event }])
  draftsOwner5.deleteNativeChatComposerDraft(rows[0].from)
  draftsOwner3.updateNativeChatComposerDraft(
    rows[0].from,
    { text: 'new explicit input' },
    'immediate'
  )
  for (let i = 0; i < rows.length; i++) {
    draftsOwner3.finishNativeChatComposerSubmission(rows[i].from, rows[i].attempt, i % 2 === 0)
  }
  gate.resolve(snapshot)
  await loading
  await draftsOwner6.nativeChatComposerDraftWritesSettled()
  expect(write).not.toHaveBeenCalled()
  expect(update).not.toHaveBeenCalled()
  expect(remove).toHaveBeenCalled()
  for (let i = 0; i < count; i++) {
    const current = draftsOwner3.readNativeChatComposerDraft(rows[i].from)
    expect(current.text).toBe(i === 0 ? 'new explicit input' : `target${i}\n\nsource${i}`)
    expect(current.images.map(({ id }) => id)).toEqual(
      i === 0 ? [] : ['shared', `target${i}`, `source${i}`]
    )
    expect(JSON.stringify(current.document ?? null)).not.toContain('residue')
    if (i > 0) {
      expect(JSON.stringify(current.document)).toContain(`/target${i}/SKILL.md`)
      expect(JSON.stringify(current.document)).toContain(`/source${i}/SKILL.md`)
    }
    expect(current.owner?.executionHostId).toBe('ssh:last')
    expect(rows[i].attempt.draft).toBeUndefined()
    expect(rows[i].attempt.scopeKey).toBe(scope('last', i))
    expect(draftsOwner3.readNativeChatComposerDraft(`agent-session:ordinary${i}`).text).toBe(
      `ordinary${i}`
    )
    expect(pending.nativeChatPendingAttachmentSnapshot(rows[i].from)).toHaveLength(1)
    expect(storage.drafts.get(scope('old', i))?.text).toBe(`residue${i}`)
    expect(storage.drafts.has(scope('last', i))).toBe(false)
  }
  expect(untouched).not.toHaveBeenCalled()
  expect(draftsOwner3.readNativeChatComposerDraft(control).text).toBe('unrelated input')
  releases.forEach((release) => release())
  notifications.mockClear()
  draftsOwner3.updateNativeChatComposerDraft(
    rows[1].from,
    { text: 'later ordinary edit' },
    'immediate'
  )
  expect(notifications).not.toHaveBeenCalled()
  releaseControl()
  vi.restoreAllMocks()
  pending.clearNativeChatPendingAttachmentsForTests()
  drafts.clearNativeChatComposerDraftsForTests()
})

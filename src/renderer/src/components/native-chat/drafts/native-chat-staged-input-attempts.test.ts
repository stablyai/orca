// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest'
import type * as BrowserAttachmentFiles from '@/lib/files/drop/browser-attachment-files'

// The browser token store is the only stand-in (its releases are counted): staging, the retained
// input hold, each attempt's lease and its custody grant run for real.
const released: string[] = []
vi.mock('@/lib/files/drop/browser-attachment-files', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowserAttachmentFiles>()),
  releaseBrowserAttachmentFiles: (paths: string[]) => {
    released.push(...paths)
  }
}))

const {
  hasNativeChatStagedFiles,
  holdNativeChatStagedInput,
  namedNativeChatStagedPaths,
  reconcileNativeChatStagedDraft,
  stageNativeChatDraftFile
} = await import('./native-chat-draft-attachment-staging')
const { captureNativeChatStagedInput, captureNativeChatStagedInputNamed } =
  await import('./native-chat-staged-input')

beforeEach(() => {
  released.length = 0
})

const local = { sessionId: 'attempts', runtimeEnvironmentId: null }

/** A retained Retry input: its original is staged, held for retry, and gone from the draft. */
function retainedRetry(scope: string, original: string) {
  stageNativeChatDraftFile(scope, original)
  const input = { text: '', attachments: [{ path: original }] }
  holdNativeChatStagedInput(scope, input)
  reconcileNativeChatStagedDraft(scope, { text: '', images: [] })
  return input
}

// D12-02 / C16-04. Two overlapping attempts of the same retained input own separate leases: the first
// one's late end (its recording, say) neither revokes the second's grant nor prunes the original the
// second still leases. The second's own end then releases it.
it('keeps an overlapping attempt whole when an earlier attempt of the same input ends', async () => {
  const scope = 'agent-session:attempts-overlap'
  const original = 'blob:attempts-overlap'
  const input = retainedRetry(scope, original)

  const first = captureNativeChatStagedInput(scope, input)
  const second = captureNativeChatStagedInput(scope, input)
  first.release()

  expect(hasNativeChatStagedFiles(scope)).toBe(true)
  expect(released).toEqual([])
  await expect(second.prepare(input, local)).resolves.toMatchObject({
    attachments: [{ path: original }]
  })
  expect((await second.prepare(input, local)).custodyLost?.()).toEqual([])

  second.release()
  expect(hasNativeChatStagedFiles(scope)).toBe(false)
  expect(released).toEqual([original])
})

// With the draft still holding the original, ending both attempts in either order releases nothing:
// the draft keeps it.
it('releases nothing a draft still holds when overlapping attempts end', () => {
  const scope = 'agent-session:attempts-draft-held'
  const original = 'blob:attempts-draft-held'
  stageNativeChatDraftFile(scope, original)
  const input = { text: '', attachments: [{ path: original }] }
  reconcileNativeChatStagedDraft(scope, { text: '', images: [{ id: 'a', path: original }] })

  const first = captureNativeChatStagedInput(scope, input)
  const second = captureNativeChatStagedInput(scope, input)
  second.release()
  first.release()

  expect(hasNativeChatStagedFiles(scope)).toBe(true)
  expect(released).toEqual([])
})

// The retained hold still ends with the attempt that took it, as before: one attempt, one release.
it('ends a retained hold with the one attempt that took it', () => {
  const scope = 'agent-session:attempts-single'
  const original = 'blob:attempts-single'
  const input = retainedRetry(scope, original)

  captureNativeChatStagedInput(scope, input).release()

  expect(hasNativeChatStagedFiles(scope)).toBe(false)
  expect(released).toEqual([original])
})

// A send naming nothing this staging holds gets no capture (and no lease).
it('captures only when the input names a staged original', () => {
  const scope = 'agent-session:attempts-named'
  stageNativeChatDraftFile(scope, 'blob:attempts-named')
  expect(captureNativeChatStagedInputNamed(scope, { text: 'no files' })).toBeUndefined()
  expect(
    captureNativeChatStagedInputNamed(scope, {
      text: '',
      attachments: [{ path: 'blob:attempts-named' }]
    })?.paths
  ).toEqual(['blob:attempts-named'])
})

/** Attachments whose `path` reads are counted: the work the intersection does per attachment. */
function countedAttachments(paths: readonly string[]) {
  const reads = { count: 0 }
  const attachments = paths.map((path) => ({
    get path() {
      reads.count += 1
      return path
    }
  }))
  return { reads, attachments }
}

// D12-04. Which staged originals a send names is linear: each attachment is read once however many
// originals are staged, at N and at 2N, with disjoint staged paths and retained leases; order is kept.
it('names staged originals in linear work, in staged order', () => {
  for (const n of [50, 100]) {
    const staged = new Set(Array.from({ length: n }, (_, index) => `blob:staged-${index}`))
    const named = Array.from({ length: n }, (_, index) => `blob:other-${index}`)
    const { reads, attachments } = countedAttachments([...named, 'blob:staged-3', 'blob:staged-1'])

    expect(namedNativeChatStagedPaths(staged, { text: '', attachments })).toEqual([
      'blob:staged-1',
      'blob:staged-3'
    ])
    expect(reads.count).toBe(n + 2)
  }
})

it('releases a late custody wait registered after recipient discard without touching a sibling', async () => {
  const { abandonNativeChatPendingStagedLeases, stagedNativeChatFiles } =
    await import('./native-chat-draft-attachment-staging')
  const scope = 'late-custody-registration'
  stageNativeChatDraftFile(scope, 'blob:late-registration')
  const first = captureNativeChatStagedInput(scope, {
    text: '',
    attachments: [{ path: 'blob:late-registration' }]
  })
  const sibling = captureNativeChatStagedInput(scope, {
    text: '',
    attachments: [{ path: 'blob:late-registration' }]
  })
  reconcileNativeChatStagedDraft(scope, { text: '', images: [] })
  abandonNativeChatPendingStagedLeases(scope)
  first.releaseWhenHeld()
  expect(stagedNativeChatFiles(scope)?.pendingLeases.size ?? 0).toBe(0)
  expect(hasNativeChatStagedFiles(scope)).toBe(true)
  sibling.releaseWhenHeld()
  expect(hasNativeChatStagedFiles(scope)).toBe(false)
})

it('ends a failed attempt while a distinct retry hold keeps the original usable', async () => {
  const { stagedNativeChatFiles } = await import('./native-chat-draft-attachment-staging')
  const scope = 'failed-attempt-recovery'
  stageNativeChatDraftFile(scope, 'blob:retry-original')
  const failed = captureNativeChatStagedInput(scope, {
    text: '',
    attachments: [{ path: 'blob:retry-original' }]
  })
  reconcileNativeChatStagedDraft(scope, { text: '', images: [] })
  failed.retainForRetry(scope)
  failed.release()
  expect(stagedNativeChatFiles(scope)?.leases.size).toBe(0)
  expect(hasNativeChatStagedFiles(scope)).toBe(true)
  const retry = captureNativeChatStagedInput(scope, {
    text: '',
    attachments: [{ path: 'blob:retry-original' }]
  })
  expect(
    (
      await retry.prepare(
        { text: '', attachments: [{ path: 'blob:retry-original' }] },
        { sessionId: 'retry', runtimeEnvironmentId: null }
      )
    ).attachments
  ).toEqual([{ path: 'blob:retry-original' }])
  retry.release()
  expect(hasNativeChatStagedFiles(scope)).toBe(false)
})

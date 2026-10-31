// @vitest-environment happy-dom
import { Profiler, StrictMode, useContext, useState, useMemo } from 'react'
import { toast } from 'sonner'
import { i18n } from '@/i18n/i18n'
import * as languageRevision from '@/i18n/translation-resource-version'
import { useAppStore } from '@/store'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client-types'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  NativeChatTextAttachments,
  NativeChatTextAttachmentScope,
  NativeChatTextAttachmentOpener
} from './NativeChatTextAttachments'
import { NativeChatTextAttachmentPreview } from './NativeChatTextAttachmentPreview'
import { AGENT_SESSION_TEXT_ATTACHMENT_READ_CAPABILITY } from '../../../../shared/agent-session-runtime-capabilities'
import {
  AttachmentTextSource,
  ATTACHMENT_TEXT_PAGE_BYTES
} from '../../../../shared/attachment-text-source'
import { NativeChatMarkdownImageOwnerContext } from './native-chat-markdown-image-owner'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'

const mocks = vi.hoisted(() => {
  const routing: { context: RuntimeFileOperationArgs | null; web: boolean } = {
    context: null,
    web: false
  }
  return {
    ...routing,
    rpc: vi.fn(),
    write: vi.fn(),
    start: vi.fn(),
    append: vi.fn(),
    finish: vi.fn(),
    cancel: vi.fn()
  }
})
const subscriptions = vi.hoisted(() => ({ registered: 0, live: 0, notifications: 0, removed: 0 }))
vi.mock('@/i18n/translation-resource-version', async (importOriginal) => {
  const original = await importOriginal<typeof languageRevision>()
  return {
    ...original,
    getTranslationResourceVersion: vi.fn(original.getTranslationResourceVersion),
    advanceTranslationResourceVersion: vi.fn(original.advanceTranslationResourceVersion),
    subscribeTranslationResourceVersion: vi.fn((callback: () => void) => {
      subscriptions.registered += 1
      subscriptions.live += 1
      const unsubscribe = original.subscribeTranslationResourceVersion(() => {
        subscriptions.notifications += 1
        callback()
      })
      return () => {
        subscriptions.live -= 1
        subscriptions.removed += 1
        unsubscribe()
      }
    })
  }
})
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.rpc }))
vi.mock('@/lib/web-client-location', () => ({ isWebClientLocation: () => mocks.web }))
vi.mock('sonner', () => ({ toast: { success: vi.fn() } }))
const path =
  '/host/agent-session-attachments/12345678-1234-1234-1234-123456789abc/orca-paste-123-abc.txt'
const target = { kind: 'environment', environmentId: 'env-text' } as const
const bytes = Buffer.from(['\ufeffstart\r\n', '🙂'.repeat(20_000), 'end'].join(''))
let capable = true

beforeEach(async () => {
  await i18n.changeLanguage('en')
  vi.mocked(toast.success).mockClear()
  capable = true
  mocks.context = null
  mocks.web = false
  mocks.cancel.mockReset().mockResolvedValue(undefined)
  replaceRuntimeEnvironmentRevisions([{ id: 'env-text', createdAt: 1 }])
  mocks.rpc.mockReset().mockImplementation(async (_target, method, request) => {
    if (method === 'status.get') {
      return {
        runtimeId: 'host-1',
        capabilities: capable ? [AGENT_SESSION_TEXT_ATTACHMENT_READ_CAPABILITY] : []
      }
    }
    const chunk = bytes.subarray(request.offset, request.offset + request.length)
    return {
      snapshot: 'a'.repeat(64),
      size: bytes.length,
      contentBase64: chunk.toString('base64'),
      bytesRead: chunk.length,
      eof: request.offset + chunk.length === bytes.length
    }
  })
  mocks.write.mockReset().mockResolvedValue(undefined)
  mocks.start.mockReset().mockResolvedValue({ canceled: false, transferId: 'output' })
  mocks.append.mockReset().mockResolvedValue(undefined)
  mocks.finish.mockReset().mockResolvedValue({ canceled: false })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      ui: { writeClipboardText: mocks.write },
      fs: {
        startDownloadedFile: mocks.start,
        appendDownloadedFileChunk: mocks.append,
        finishDownloadedFile: mocks.finish,
        cancelDownloadedFile: mocks.cancel
      }
    }
  })
})
afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('en')
})

const waitUntilEnabled = (name: string) =>
  waitFor(() => expect(screen.getByRole('button', { name }).hasAttribute('disabled')).toBe(false))

it('keeps terminal text unchanged and does no body reads until a structured reference is opened', async () => {
  const content = `Read @${path}`
  const renderText = (text: string) => <span>{text}</span>
  const baseline = { ...subscriptions }
  const view = render(
    <NativeChatTextAttachments content={content} structured={false} renderText={renderText} />
  )
  expect(subscriptions).toEqual(baseline)
  const terminalNode = view.container.firstChild
  const revision = languageRevision.getTranslationResourceVersion()
  await act(async () => {
    await i18n.changeLanguage('fr')
  })
  expect(languageRevision.getTranslationResourceVersion()).toBeGreaterThan(revision)
  view.rerender(
    <NativeChatTextAttachments content={content} structured={false} renderText={renderText} />
  )
  expect(view.container.firstChild).toBe(terminalNode)
  expect(subscriptions).toEqual(baseline)
  expect(mocks.rpc).not.toHaveBeenCalled()
  await act(async () => {
    await i18n.changeLanguage('en')
  })
  expect(subscriptions).toEqual(baseline)
  expect(screen.queryByRole('button')).toBeNull()
  expect(view.container.textContent).toBe(content)
  view.rerender(
    <NativeChatTextAttachments
      content={content}
      structured
      runtimeContext={{ target, worktreeId: 'w', worktreePath: '/repo' }}
      renderText={renderText}
    />
  )
  expect(mocks.rpc).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Pasted text' }))
  await waitUntilEnabled('Copy contents')
  expect(
    mocks.rpc.mock.calls.filter((call) => call[1] === 'agentSessionAttachment.readTextChunk')
  ).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: 'Copy contents' }))
  await waitFor(() => expect(mocks.write).toHaveBeenCalledWith(bytes.toString('utf8')))
  await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Copied contents'))
  expect(screen.getByText('Section 1/1')).toBeTruthy()
  expect(screen.getByRole('spinbutton', { name: 'Attachment page' })).toBeTruthy()
  await waitUntilEnabled('Save file')
  fireEvent.click(screen.getByRole('button', { name: 'Save file' }))
  await waitFor(() => expect(mocks.finish).toHaveBeenCalled())
  expect(
    Buffer.concat(
      mocks.append.mock.calls.map(([args]) => Buffer.from(args.contentBase64, 'base64'))
    )
  ).toEqual(bytes)
})

it('shows the old-host limitation and refreshes capability on Retry without affecting the message', async () => {
  capable = false
  render(<NativeChatTextAttachmentPreview path={path} target={target} onClose={() => {}} />)
  await screen.findByText(/This host cannot open text attachments yet/)
  expect(mocks.rpc.mock.calls.every((call) => call[1] === 'status.get')).toBe(true)
  capable = true
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await waitUntilEnabled('Copy contents')
})

it('survives StrictMode cleanup and refuses clipboard publication after the owner is re-paired', async () => {
  render(
    <StrictMode>
      <NativeChatTextAttachmentPreview path={path} target={target} onClose={() => {}} />
    </StrictMode>
  )
  await waitUntilEnabled('Copy contents')
  const gate = Promise.withResolvers<void>()
  const started = Promise.withResolvers<void>()
  const normal = mocks.rpc.getMockImplementation()!
  mocks.rpc.mockImplementationOnce(async (...args) => {
    started.resolve()
    await gate.promise
    return normal(...args)
  })
  fireEvent.click(screen.getByRole('button', { name: 'Copy contents' }))
  await started.promise
  await act(async () => {
    replaceRuntimeEnvironmentRevisions([{ id: 'env-text', createdAt: 2 }])
    gate.resolve()
  })
  expect(mocks.write).not.toHaveBeenCalled()
})

it.each([true, false])(
  'keeps focused stateful composer descendants mounted when owner context changes (structured=%s)',
  async (enabled) => {
    mocks.context = { target: { kind: 'local' }, worktreeId: 'w', worktreePath: '/repo' }
    function Child() {
      const [value, setValue] = useState('')
      const open = useContext(NativeChatTextAttachmentOpener)
      return (
        <>
          <input
            aria-label="draft"
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
          <button onClick={() => open?.(path)}>Open source</button>
        </>
      )
    }
    function Ui() {
      const runtimeContext = mocks.context
      const owner = useMemo(
        () => ({ runtimeContext, isVisible: true, fileLinkContext: null }),
        [runtimeContext]
      )
      return (
        <NativeChatMarkdownImageOwnerContext.Provider value={owner}>
          <NativeChatTextAttachmentScope enabled={enabled}>
            <Child />
          </NativeChatTextAttachmentScope>
        </NativeChatMarkdownImageOwnerContext.Provider>
      )
    }
    const ui = () => <Ui />
    const view = render(ui())
    const input = screen.getByRole('textbox', { name: 'draft' })
    fireEvent.change(input, { target: { value: 'local editor state' } })
    input.focus()
    mocks.context = { ...mocks.context, worktreePath: '/renamed' }
    view.rerender(ui())
    expect(screen.getByRole('textbox', { name: 'draft', hidden: true })).toBe(input)
    expect(document.activeElement).toBe(input)
    expect(input.getAttribute('value')).toBe('local editor state')
    if (!enabled) {
      expect(mocks.rpc).not.toHaveBeenCalled()
      return
    }
    fireEvent.click(screen.getByRole('button', { name: 'Open source' }))
    await waitUntilEnabled('Copy contents')
    const gate = Promise.withResolvers<unknown>()
    const normal = mocks.rpc.getMockImplementation()!
    mocks.rpc.mockImplementationOnce(() => gate.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Copy contents' }))
    await act(async () => {})
    mocks.context = { ...mocks.context, expectedSshConnectionGeneration: 2 }
    view.rerender(ui())
    expect(screen.queryByRole('button', { name: 'Copy contents' })).toBeNull()
    await act(async () =>
      gate.resolve(
        await normal(target, 'agentSessionAttachment.readTextChunk', {
          offset: 0,
          length: bytes.length
        })
      )
    )
    expect(mocks.write).not.toHaveBeenCalled()
    expect(mocks.finish).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Open source' }))
    await waitUntilEnabled('Copy contents')
    expect(screen.getByRole('textbox', { name: 'draft', hidden: true })).toBe(input)
    const picker = Promise.withResolvers<{ canceled: false; transferId: string }>()
    mocks.start.mockReturnValueOnce(picker.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Save file' }))
    await act(async () => {})
    mocks.context = { ...mocks.context, worktreePath: '/changed-again' }
    view.rerender(ui())
    await act(async () => picker.resolve({ canceled: false, transferId: 'late-output' }))
    expect(mocks.cancel).toHaveBeenCalledWith({ transferId: 'late-output' })
    expect(mocks.append).not.toHaveBeenCalled()
    expect(mocks.finish).not.toHaveBeenCalled()
  }
)

it('exports all raw web bytes and cancels desktop picker/output failures', async () => {
  mocks.web = true
  const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:35636')
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  const view = render(
    <NativeChatTextAttachmentPreview path={path} target={target} onClose={() => {}} />
  )
  const save = () => screen.getByRole('button', { name: 'Save file' })
  await waitUntilEnabled('Save file')
  fireEvent.click(save())
  await waitFor(() => expect(click).toHaveBeenCalledOnce())
  const blob = create.mock.calls[0]![0]
  if (!(blob instanceof Blob)) {
    throw new Error('Expected a complete file Blob')
  }
  expect(Buffer.from(await blob.arrayBuffer())).toEqual(bytes)
  expect(mocks.start).not.toHaveBeenCalled()
  create.mockRestore()
  click.mockRestore()
  view.unmount()
  mocks.web = false
  mocks.start.mockResolvedValueOnce({ canceled: true })
  render(<NativeChatTextAttachmentPreview path={path} target={target} onClose={() => {}} />)
  await waitUntilEnabled('Save file')
  fireEvent.click(save())
  await waitFor(() => expect(mocks.start).toHaveBeenCalledOnce())
  await waitUntilEnabled('Save file')
  expect(mocks.append).not.toHaveBeenCalled()
  expect(mocks.finish).not.toHaveBeenCalled()
  mocks.append.mockRejectedValueOnce(new Error('Output failed'))
  fireEvent.click(save())
  await screen.findByText('Output failed')
  expect(mocks.cancel).toHaveBeenCalledWith({ transferId: 'output' })
  expect(mocks.finish).not.toHaveBeenCalled()
})

it.each([1, 10])(
  'bounds real locale publication and releases %i open previews independently of closed labels',
  async (count) => {
    const language = 'fr-x-pr35636-population'
    const commits = vi.fn()
    const publications: {
      live: number
      delta: number
      notifications: number
      commits: number
      snapshots: number
    }[] = []
    const initialLive = subscriptions.live
    const unrelatedWorktree = useAppStore.getState().activeWorktreeId
    const originalReads = mocks.rpc.mock.calls.length
    const renderText = (text: string) => <span>{text}</span>
    const context = { target, worktreeId: 'w', worktreePath: '/repo' }
    const generated = (index: number) => path.replace('123-abc', `population-${index}`)
    const ordinary = path.replace('orca-paste-123-abc.txt', 'Pasted text')
    i18n.addResourceBundle(language, 'translation', {
      components: {
        'native-chat': {
          composer: { pastedTextLabel: 'Texte collé' },
          textAttachmentPreview: {
            copiedContents: 'Contenu copié',
            copyContents: 'Copier tout',
            attachmentPage: 'Page jointe',
            section: 'Partie {{section}}/{{sections}}'
          }
        }
      }
    })
    const view = render(
      <>
        {Array.from({ length: count }, (_, index) => (
          <Profiler key={index} id={String(index)} onRender={commits}>
            <NativeChatTextAttachments
              content={`@${generated(index)}`}
              structured
              runtimeContext={context}
              renderText={renderText}
            />
          </Profiler>
        ))}
        <NativeChatTextAttachments
          content={`@"${ordinary}"`}
          structured
          runtimeContext={context}
          renderText={renderText}
        />
      </>
    )
    try {
      const closedLive = subscriptions.live
      expect(closedLive - initialLive).toBe(count + 1)
      expect(mocks.rpc).toHaveBeenCalledTimes(originalReads)
      const registrations = subscriptions.registered
      const closedButtons = screen.getAllByRole('button', { name: 'Pasted text' }).slice(0, count)
      for (const node of closedButtons) {
        fireEvent.click(node)
      }
      await waitFor(() =>
        expect(
          screen
            .getAllByRole('button', { name: 'Copy contents' })
            .every((node) => !node.hasAttribute('disabled'))
        ).toBe(true)
      )
      expect(subscriptions.live - closedLive).toBe(count)
      expect(subscriptions.registered - registrations).toBe(count)
      const inputs = Array.from(document.querySelectorAll('input[aria-label="Attachment page"]'))
      expect(inputs).toHaveLength(count)
      const reads = mocks.rpc.mock.calls.length
      const settledCommits = commits.mock.calls.length
      const revision = languageRevision.getTranslationResourceVersion()
      const notifications = subscriptions.notifications
      await act(async () => useAppStore.setState({ activeWorktreeId: 'other35636' }))
      expect(commits).toHaveBeenCalledTimes(settledCommits)
      expect(subscriptions.notifications).toBe(notifications)
      expect(languageRevision.getTranslationResourceVersion()).toBe(revision)
      const publish = async (event: () => Promise<void> | void) => {
        const live = subscriptions.live
        const before = languageRevision.getTranslationResourceVersion()
        const notified = subscriptions.notifications
        const published = vi.mocked(languageRevision.advanceTranslationResourceVersion).mock.calls
          .length
        const rendered = commits.mock.calls.length
        const snapshots = vi.mocked(languageRevision.getTranslationResourceVersion).mock.calls
          .length
        await act(event)
        const delta = languageRevision.getTranslationResourceVersion() - before
        expect(delta).toBeGreaterThan(0)
        expect(
          vi.mocked(languageRevision.advanceTranslationResourceVersion).mock.calls.length -
            published
        ).toBe(delta)
        expect(subscriptions.notifications - notified).toBe(live * delta)
        expect(commits.mock.calls.length - rendered).toBeGreaterThanOrEqual(count)
        expect(commits.mock.calls.length - rendered).toBeLessThanOrEqual(count * delta)
        const snapshotCalls =
          vi.mocked(languageRevision.getTranslationResourceVersion).mock.calls.length - snapshots
        expect(snapshotCalls).toBeGreaterThan(0)
        expect(snapshotCalls).toBeLessThanOrEqual(16 * live * delta + 5)
        publications.push({
          live,
          delta,
          notifications: subscriptions.notifications - notified,
          commits: commits.mock.calls.length - rendered,
          snapshots: snapshotCalls
        })
        expect(mocks.rpc).toHaveBeenCalledTimes(reads)
      }
      await publish(async () => {
        await i18n.changeLanguage(language)
      })
      expect(
        Array.from(view.container.querySelectorAll('button')).filter(
          (node) => node.textContent === 'Texte collé'
        )
      ).toHaveLength(count)
      expect(
        Array.from(view.container.querySelectorAll('button')).filter(
          (node) => node.textContent === 'Pasted text'
        )
      ).toHaveLength(1)
      expect(Array.from(document.querySelectorAll('input[aria-label="Page jointe"]'))).toEqual(
        inputs
      )
      expect(screen.getAllByText('Partie 1/1')).toHaveLength(count)
      await publish(() => {
        i18n.addResource(
          language,
          'translation',
          'components.native-chat.textAttachmentPreview.copyContents',
          'Copier encore'
        )
      })
      expect(
        Array.from(document.querySelectorAll('button')).filter(
          (node) => node.textContent === 'Copier encore'
        )
      ).toHaveLength(count)
      await publish(() => {
        i18n.addResource('inactive35636', 'translation', 'unrelated35636', 'unrelated')
      })
      fireEvent.click(screen.getAllByRole('button', { name: 'Copier encore' })[0]!)
      await waitFor(() => expect(mocks.write).toHaveBeenCalledWith(bytes.toString('utf8')))
      await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Contenu copié'))
      const removals = subscriptions.removed
      for (const node of document.querySelectorAll('[data-slot="sheet-close"]')) {
        fireEvent.click(node)
      }
      await waitFor(() => expect(screen.queryAllByRole('spinbutton')).toHaveLength(0))
      expect(subscriptions.live).toBe(closedLive)
      expect(subscriptions.removed - removals).toBe(count)
      const closedReads = mocks.rpc.mock.calls.length
      const before = languageRevision.getTranslationResourceVersion()
      const notified = subscriptions.notifications
      await act(async () => {
        i18n.addResource(
          language,
          'translation',
          'components.native-chat.composer.pastedTextLabel',
          'Texte fermé'
        )
      })
      expect(subscriptions.notifications - notified).toBe(
        closedLive * (languageRevision.getTranslationResourceVersion() - before)
      )
      expect(screen.getAllByRole('button', { name: 'Texte fermé' })).toHaveLength(count)
      expect(mocks.rpc).toHaveBeenCalledTimes(closedReads)
      view.unmount()
      expect(subscriptions.live).toBe(initialLive)
      const retiredNotifications = subscriptions.notifications
      const retiredCommits = commits.mock.calls.length
      await act(async () => {
        i18n.addResource(language, 'translation', 'unrelatedRetired35636', 'value')
      })
      expect(subscriptions.notifications).toBe(retiredNotifications)
      expect(commits).toHaveBeenCalledTimes(retiredCommits)
      expect(mocks.rpc).toHaveBeenCalledTimes(closedReads)
      process.stdout.write(
        `PR35636 desktop locale population ${JSON.stringify({ count, closedLabels: count + 1, openPreviewListeners: count, remainingListeners: subscriptions.live, reads, publications })}\n`
      )
    } finally {
      view.unmount()
      useAppStore.setState({ activeWorktreeId: unrelatedWorktree })
      await i18n.changeLanguage('en')
      i18n.removeResourceBundle(language, 'translation')
      i18n.removeResourceBundle('inactive35636', 'translation')
    }
  }
)

it('presents owned reader and hook failures in the current locale without re-reading or replacing external errors', async () => {
  const language = 'fr-x-pr35636-errors'
  i18n.addResourceBundle(language, 'translation', {
    components: {
      'native-chat': {
        textAttachmentPreview: {
          hostUpdate: 'Mettre à jour cet hôte, puis réessayer.',
          notText: 'Enregistrer ce fichier pour l’ouvrir.',
          openFailed: 'Impossible d’ouvrir la pièce jointe.',
          unreadableReply: 'Réponse illisible.',
          incompleteReply: 'Réponse incomplète.'
        }
      }
    }
  })
  capable = false
  const view = render(
    <NativeChatTextAttachmentPreview path={path} target={target} onClose={() => {}} />
  )
  await screen.findByText(
    'This host cannot open text attachments yet. Update Orca on that host, then retry.'
  )
  const reads = mocks.rpc.mock.calls.length
  await act(async () => {
    await i18n.changeLanguage(language)
  })
  expect(screen.getByText('Mettre à jour cet hôte, puis réessayer.')).toBeTruthy()
  expect(mocks.rpc).toHaveBeenCalledTimes(reads)
  capable = true
  mocks.rpc.mockRejectedValueOnce(new TypeError('invalid encoding'))
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await screen.findByText('Enregistrer ce fichier pour l’ouvrir.')
  mocks.rpc.mockRejectedValueOnce('external non-error')
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await screen.findByText('Impossible d’ouvrir la pièce jointe.')
  mocks.rpc.mockRejectedValueOnce(new Error('External diagnostic unchanged'))
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await screen.findByText('External diagnostic unchanged')
  mocks.rpc
    .mockResolvedValueOnce({ capabilities: [AGENT_SESSION_TEXT_ATTACHMENT_READ_CAPABILITY] })
    .mockResolvedValueOnce({})
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await screen.findByText('Réponse illisible.')
  mocks.rpc
    .mockResolvedValueOnce({ capabilities: [AGENT_SESSION_TEXT_ATTACHMENT_READ_CAPABILITY] })
    .mockResolvedValueOnce({
      snapshot: 'a'.repeat(64),
      size: 1,
      bytesRead: 0,
      contentBase64: '',
      eof: true
    })
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await screen.findByText('Réponse incomplète.')
  view.unmount()
  await i18n.changeLanguage('en')
  i18n.removeResourceBundle(language, 'translation')
})

it('commits page drafts once without requesting uncached digit prefixes and synchronizes navigation', async () => {
  const content = Buffer.from('a\n'.repeat(ATTACHMENT_TEXT_PAGE_BYTES * 6))
  const gate = Promise.withResolvers<void>()
  const pageCalls = vi.spyOn(AttachmentTextSource.prototype, 'page')
  let held = false
  let fail = false
  const offsets: number[] = []
  const normal = mocks.rpc.getMockImplementation()!
  mocks.rpc.mockImplementation(async (...args) => {
    if (args[1] === 'status.get') {
      return normal(...args)
    }
    const request = args[2]
    offsets.push(request.offset)
    if (held && (request.offset === 0 || request.offset === 11 * ATTACHMENT_TEXT_PAGE_BYTES - 3)) {
      await gate.promise
    }
    if (fail) {
      fail = false
      throw new Error('offline')
    }
    const chunk = content.subarray(request.offset, request.offset + request.length)
    return {
      snapshot: 'a'.repeat(64),
      size: content.length,
      contentBase64: chunk.toString('base64'),
      bytesRead: chunk.length,
      eof: request.offset + chunk.length === content.length
    }
  })
  try {
    const view = render(
      <NativeChatTextAttachmentPreview path={path} target={target} onClose={() => {}} />
    )
    const input = () => {
      const node = screen.getByRole('spinbutton', { name: 'Attachment page' })
      if (!(node instanceof HTMLInputElement)) {
        throw new Error('Expected page input')
      }
      return node
    }
    const edit = (value: string) => fireEvent.change(input(), { target: { value } })
    const commit = () => fireEvent.blur(input())
    const ready = () => waitUntilEnabled('Copy contents')
    await ready()
    for (const page of ['3', '5']) {
      edit(page)
      commit()
      await ready()
      expect(input().value).toBe(page)
    }
    const before = offsets.slice()
    held = true
    await act(async () => {
      edit('')
    })
    expect(offsets).toEqual(before)
    await act(async () => {
      edit('1')
    })
    expect(offsets).toEqual(before)
    expect(input().value).toBe('1')
    expect(input().disabled).toBe(false)
    await act(async () => {
      edit('12')
    })
    expect(offsets).toEqual(before)
    act(() => input().focus())
    fireEvent.keyDown(input(), { key: 'Enter', isComposing: true })
    expect(document.activeElement).toBe(input())
    expect(offsets).toEqual(before)
    fireEvent.keyDown(input(), { key: 'Enter' })
    await waitFor(() => expect(offsets).toEqual([...before, 11 * ATTACHMENT_TEXT_PAGE_BYTES - 3]))
    expect(input().disabled).toBe(true)
    const pendingCalls = pageCalls.mock.calls.length
    commit()
    expect(pageCalls).toHaveBeenCalledTimes(pendingCalls)
    await act(async () => {
      held = false
      gate.resolve()
    })
    await ready()
    expect(input().value).toBe('12')
    const committedCalls = pageCalls.mock.calls.length
    for (const invalid of ['', '0', '13', '1.5']) {
      edit(invalid)
      expect(input().value).toBe(invalid)
      commit()
      expect(input().value).toBe('12')
    }
    commit()
    expect(pageCalls).toHaveBeenCalledTimes(committedCalls)
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await ready()
    expect(screen.getByText(/Section 2\//)).toBeTruthy()
    commit()
    expect(screen.getByText(/Section 2\//)).toBeTruthy()
    edit('')
    edit('12')
    commit()
    await ready()
    expect(screen.getByText(/Section 1\//)).toBeTruthy()
    expect(pageCalls).toHaveBeenCalledTimes(committedCalls + 2)
    edit('9')
    fireEvent.click(screen.getByRole('button', { name: 'First' }))
    await ready()
    expect(input().value).toBe('1')
    fail = true
    edit('6')
    commit()
    await screen.findByRole('alert')
    edit('7')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await ready()
    expect(input().value).toBe('1')
    edit('8')
    view.rerender(
      <NativeChatTextAttachmentPreview
        path={path.replace('.txt', '-other.txt')}
        target={target}
        onClose={() => {}}
      />
    )
    await ready()
    expect(input().value).toBe('1')
    process.stdout.write(
      `PR35636 desktop pager presentation ${JSON.stringify({ offsets, pageCalls: pageCalls.mock.calls.length })}\n`
    )
  } finally {
    gate.resolve()
    pageCalls.mockRestore()
  }
})

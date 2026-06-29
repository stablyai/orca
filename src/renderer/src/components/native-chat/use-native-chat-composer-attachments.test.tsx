// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createElement, useRef, useState } from 'react'
import {
  clearNativeChatAttachmentCacheForTests,
  readNativeChatAttachmentCache,
  useNativeChatComposerAttachments
} from './use-native-chat-composer-attachments'
import type { NativeChatResolvedTarget } from './native-chat-composer-target'

const sendNativeChatImageAttachments = vi.fn()
vi.mock('./native-chat-runtime-send', () => ({
  sendNativeChatImageAttachments: (...args: unknown[]) => sendNativeChatImageAttachments(...args)
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))
vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  isRemoteRuntimePtyId: () => false
}))

type ProbeApi = ReturnType<typeof useNativeChatComposerAttachments>

const target: NativeChatResolvedTarget = {
  ptyId: 'pty-1',
  settings: { activeRuntimeEnvironmentId: null }
}

function Probe({
  scopeKey,
  onReady
}: {
  scopeKey: string
  onReady: (api: ProbeApi) => void
}): React.JSX.Element {
  const [caret, setCaret] = useState(0)
  const [, setDraftValue] = useState('')
  const [, setNotice] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const api = useNativeChatComposerAttachments({
    attachmentScopeKey: scopeKey,
    caret,
    resolveTarget: () => target,
    textareaRef,
    setCaret,
    setDraft: (updater) => setDraftValue((previous) => updater(previous)),
    setNotice
  })
  onReady(api)
  return createElement('textarea', { ref: textareaRef })
}

async function renderProbe(scopeKey: string): Promise<{ root: Root; api: ProbeApi }> {
  const container = document.createElement('div')
  document.body.append(container)
  let api: ProbeApi | null = null
  const root = createRoot(container)
  await act(async () => {
    root.render(createElement(Probe, { scopeKey, onReady: (next) => (api = next) }))
  })
  if (!api) {
    throw new Error('Probe did not render')
  }
  return { root, api }
}

describe('useNativeChatComposerAttachments', () => {
  afterEach(() => {
    clearNativeChatAttachmentCacheForTests()
    sendNativeChatImageAttachments.mockReset()
    document.body.replaceChildren()
  })

  it('pastes image attachments into the TUI immediately and restores native chips on remount', async () => {
    const first = await renderProbe('pty-1')

    await act(async () => {
      first.api.attachLocalPaths(['/tmp/orca-native-chat-attach-test.png'])
    })

    expect(sendNativeChatImageAttachments).toHaveBeenCalledWith(target.settings, 'pty-1', [
      '/tmp/orca-native-chat-attach-test.png'
    ])
    expect(readNativeChatAttachmentCache('pty-1')).toMatchObject([
      { path: '/tmp/orca-native-chat-attach-test.png' }
    ])

    act(() => first.root.unmount())
    const second = await renderProbe('pty-1')

    expect(second.api.imageAttachments).toMatchObject([
      { path: '/tmp/orca-native-chat-attach-test.png' }
    ])
    act(() => second.root.unmount())
  })
})

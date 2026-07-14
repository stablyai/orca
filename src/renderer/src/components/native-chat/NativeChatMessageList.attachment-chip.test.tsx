// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { NativeChatLiveSession } from './use-native-chat-live-session'

// Stable, lightweight stubs so rendering the list never pulls in the markdown
// pipeline or the tool-run tree (both irrelevant to attachment chips) — and so
// no child returns a fresh identity that could loop an effect.
vi.mock('@/components/sidebar/CommentMarkdown', () => ({
  default: ({ content }: { content: string }) => <div data-testid="markdown">{content}</div>
}))
vi.mock('./NativeChatToolRun', () => ({
  NativeChatToolRun: () => <div data-testid="tool-run" />
}))

const toastMock = vi.hoisted(() => ({ error: vi.fn() }))
vi.mock('sonner', () => ({ toast: toastMock }))

import { NativeChatMessageList } from './NativeChatMessageList'

// One stable open spy reused across renders (a fresh spy per render could churn
// effects and hides real regressions); reset between tests.
const openSpy =
  vi.fn<
    (args: {
      hash: string
      fileName: string
      mime: string
    }) => Promise<{ ok: true } | { ok: false; error: string }>
  >()

function installApi(withAttachmentApi = true): void {
  ;(window as unknown as { api: unknown }).api = withAttachmentApi
    ? { chatImportAttachment: { open: openSpy } }
    : {}
}

function attachmentMessage(overrides?: Partial<NativeChatMessage>): NativeChatMessage {
  return {
    id: 'm1',
    role: 'assistant',
    blocks: [
      {
        type: 'attachment',
        kind: 'file',
        hash: 'abc123',
        fileName: 'report.pdf',
        mime: 'application/pdf',
        size: 1234
      }
    ],
    timestamp: 1,
    source: 'transcript',
    ...overrides
  }
}

function sessionWith(messages: NativeChatMessage[]): NativeChatLiveSession {
  return {
    messages,
    status: 'ready',
    sessionId: 'sess-1',
    agent: 'claude',
    hasMore: false,
    loadingEarlier: false,
    loadEarlier: vi.fn()
  }
}

function renderList(session: NativeChatLiveSession): void {
  render(
    <NativeChatMessageList session={session} isWorking={false} expandSignal={false} fontScale={1} />
  )
}

describe('NativeChatMessageList attachment chips', () => {
  beforeEach(() => {
    openSpy.mockReset()
    openSpy.mockResolvedValue({ ok: true })
    toastMock.error.mockReset()
    installApi(true)
  })

  afterEach(() => {
    cleanup()
  })

  it('renders an attachment-only message as a chip (not skipped by the empty guard)', () => {
    renderList(sessionWith([attachmentMessage()]))
    expect(screen.getByText('report.pdf')).toBeInTheDocument()
  })

  it('opens the attachment with hash/fileName/mime when the chip is clicked', () => {
    renderList(sessionWith([attachmentMessage()]))
    fireEvent.click(screen.getByText('report.pdf'))
    expect(openSpy).toHaveBeenCalledWith({
      hash: 'abc123',
      fileName: 'report.pdf',
      mime: 'application/pdf'
    })
  })

  it('shows an error toast when opening fails', async () => {
    openSpy.mockResolvedValue({ ok: false, error: 'blob missing' })
    renderList(sessionWith([attachmentMessage()]))
    fireEvent.click(screen.getByText('report.pdf'))
    // Flush the open() promise microtask before asserting the toast.
    await Promise.resolve()
    await Promise.resolve()
    expect(toastMock.error).toHaveBeenCalled()
  })

  it('does not throw when the web build lacks chatImportAttachment', () => {
    installApi(false)
    renderList(sessionWith([attachmentMessage()]))
    expect(() => fireEvent.click(screen.getByText('report.pdf'))).not.toThrow()
    expect(openSpy).not.toHaveBeenCalled()
  })

  it('toasts (no unhandled rejection) when open resolves undefined — the real web fallback Proxy', async () => {
    // Why: on the web client window.api is a fallback Proxy, so open() is a truthy
    // stub that resolves undefined; reading result.ok directly would throw.
    openSpy.mockResolvedValue(undefined as unknown as { ok: true })
    renderList(sessionWith([attachmentMessage()]))
    fireEvent.click(screen.getByText('report.pdf'))
    await Promise.resolve()
    await Promise.resolve()
    expect(toastMock.error).toHaveBeenCalled()
  })
})

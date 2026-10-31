// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { i18n } from '@/i18n/i18n'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import { NativeChatTextAttachmentPreview } from './NativeChatTextAttachmentPreview'
import {
  AttachmentTextSource,
  ATTACHMENT_TEXT_PAGE_BYTES
} from '../../../../shared/attachment-text-source'

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.rpc }))
const path = '/host/agent-session-attachments/12345678-1234-1234-1234-123456789abc/report.txt'
const target = { kind: 'environment', environmentId: 'env-text' } as const
beforeEach(async () => {
  await i18n.changeLanguage('en')
  replaceRuntimeEnvironmentRevisions([{ id: 'env-text', createdAt: 1 }])
  mocks.rpc.mockReset().mockResolvedValue({
    runtimeId: 'host-1',
    capabilities: ['native-chat.text-attachment-read.v1']
  })
})
afterEach(cleanup)
const waitUntilEnabled = (name: string) =>
  waitFor(() => expect(screen.getByRole('button', { name }).hasAttribute('disabled')).toBe(false))

it.each([
  { action: 'Next', mode: 'held', page: '12', section: 2 },
  { action: 'First', mode: 'held', page: '1', section: 1 },
  { action: 'Last', mode: 'held', page: '12', section: 32 },
  { action: 'Previous', mode: 'held', page: '11', section: 32 },
  { action: 'Next', mode: 'cached', page: '12', section: 2 },
  { action: 'Next', mode: 'failed', page: '5', section: 2 },
  { action: 'Next', mode: 'unmounted', page: '5', section: 1 },
  { action: 'Previous', mode: 'endpoint', page: '1', section: 1 }
])(
  'joins an edited field before $action ($mode) through actual DOM press admission',
  async ({ action, mode, page, section }) => {
    const content = Buffer.from('a\n'.repeat(ATTACHMENT_TEXT_PAGE_BYTES * 6))
    for (let page = 0; page < 12; page++) {
      content.write(
        `P${String(page + 1).padStart(2, '0')}-S1-L001 SECTIONTOP\n`,
        page * ATTACHMENT_TEXT_PAGE_BYTES
      )
    }
    const gate = Promise.withResolvers<void>()
    const originalPage = AttachmentTextSource.prototype.page
    let failurePresentations = 0
    const pageCalls = vi.spyOn(AttachmentTextSource.prototype, 'page').mockImplementation(function (
      this: AttachmentTextSource,
      page,
      subpage = 0
    ) {
      if (mode === 'failed' && page === 4 && subpage === 1) {
        expect(screen.getAllByRole('alert')).toHaveLength(1)
        failurePresentations++
      }
      return originalPage.call(this, page, subpage)
    })
    const normal = mocks.rpc.getMockImplementation()!
    const offsets: number[] = []
    let held = false
    mocks.rpc.mockImplementation(async (...args) => {
      if (args[1] === 'status.get') {
        return normal(...args)
      }
      const request = args[2]
      offsets.push(request.offset)
      if (
        held &&
        request.offset === (mode === 'endpoint' ? 0 : 11 * ATTACHMENT_TEXT_PAGE_BYTES - 3)
      ) {
        await gate.promise
        if (mode === 'failed') {
          throw new Error('offline')
        }
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
    const ready = () => waitUntilEnabled('Copy contents')
    const go = async (value: string) => {
      act(() => input().focus())
      edit(value)
      act(() => input().blur())
      await ready()
    }
    try {
      await ready()
      if (mode === 'cached') {
        await go('12')
      }
      if (mode === 'endpoint') {
        await go('3')
      }
      await go('5')
      const fieldPage = mode === 'endpoint' ? 0 : 11
      const owner = pageCalls.mock.contexts.at(-1)
      const beforeCalls = pageCalls.mock.calls.length
      const beforeOffsets = offsets.slice()
      act(() => input().focus())
      for (const value of mode === 'endpoint' ? ['', '1'] : ['', '1', '12']) {
        edit(value)
        expect(pageCalls).toHaveBeenCalledTimes(beforeCalls)
        expect(offsets).toEqual(beforeOffsets)
      }
      held = mode !== 'cached'
      const button = screen.getByRole('button', { name: action })
      expect(button.hasAttribute('disabled')).toBe(false)
      fireEvent.pointerDown(button, { pointerId: 1, button: 0 })
      act(() => button.focus())
      expect(document.activeElement).toBe(button)
      expect(pageCalls.mock.calls.slice(beforeCalls)).toEqual([[fieldPage, 0]])
      expect(button.hasAttribute('disabled')).toBe(false)
      fireEvent.pointerUp(button, { pointerId: 1, button: 0 })
      fireEvent.click(button)
      if (mode !== 'cached') {
        expect(pageCalls.mock.calls.slice(beforeCalls)).toEqual([[fieldPage, 0]])
        await waitFor(() =>
          expect(offsets).toEqual([
            ...beforeOffsets,
            Math.max(0, fieldPage * ATTACHMENT_TEXT_PAGE_BYTES - 3)
          ])
        )
        expect(button.hasAttribute('disabled')).toBe(true)
        expect(input().value).toBe('5')
        expect(screen.getByText(/Section 1\//)).toBeTruthy()
      }
      if (mode === 'unmounted') {
        view.unmount()
        expect(owner?.disposed).toBe(true)
        await act(async () => {
          gate.resolve()
        })
        expect(pageCalls.mock.calls.slice(beforeCalls)).toEqual([[fieldPage, 0]])
        expect(screen.queryByRole('spinbutton')).toBeNull()
      } else {
        await act(async () => {
          held = false
          gate.resolve()
        })
        await ready()
        const nextCall =
          action === 'First'
            ? [0, 0]
            : action === 'Last'
              ? [11, Number.MAX_SAFE_INTEGER]
              : action === 'Previous'
                ? [10, Number.MAX_SAFE_INTEGER]
                : [mode === 'failed' ? 4 : 11, 1]
        expect(pageCalls.mock.calls.slice(beforeCalls)).toEqual(
          mode === 'endpoint' ? [[0, 0]] : [[11, 0], nextCall]
        )
        expect(failurePresentations).toBe(mode === 'failed' ? 1 : 0)
        expect(input().value).toBe(page)
        expect(screen.getByText(`Section ${section}/32`)).toBeTruthy()
        if (action === 'First') {
          expect(screen.getByText('P01-S1-L001 SECTIONTOP')).toBeTruthy()
        }
        if (mode === 'cached') {
          expect(offsets).toEqual(beforeOffsets)
        }
        if (mode === 'held' && action === 'Next') {
          expect(offsets).toEqual([
            ...beforeOffsets,
            Math.max(0, fieldPage * ATTACHMENT_TEXT_PAGE_BYTES - 3)
          ])
        }
        // An untouched field does not reset a later section or add a dispatch.
        const calls = pageCalls.mock.calls.length
        act(() => input().focus())
        act(() => input().blur())
        expect(pageCalls).toHaveBeenCalledTimes(calls)
        expect(screen.getByText(`Section ${section}/32`)).toBeTruthy()
      }
      process.stdout.write(
        `PR35636 DOM join ${JSON.stringify({ action, mode, calls: pageCalls.mock.calls.slice(beforeCalls), offsets })}\n`
      )
    } finally {
      gate.resolve()
      view.unmount()
      pageCalls.mockRestore()
    }
  }
)

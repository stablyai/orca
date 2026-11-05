// @vitest-environment happy-dom

import React, { act, type ReactNode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getPlatform: vi.fn(),
  getVersion: vi.fn(),
  readFeedbackImageFiles: vi.fn(),
  submit: vi.fn(),
  toastWarning: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warning: mocks.toastWarning
  }
}))

vi.mock('@/components/ui/dialog', async () => {
  const ReactModule = await import('react')
  const Section = ({ children }: { children?: ReactNode }) => <div>{children}</div>
  return {
    Dialog: ({ children }: { children?: ReactNode }) => <>{children}</>,
    DialogContent: ReactModule.forwardRef<
      HTMLDivElement,
      React.HTMLAttributes<HTMLDivElement> & {
        children?: ReactNode
        onOpenAutoFocus?: (event: Event) => void
      }
    >(function DialogContent({ children, onOpenAutoFocus: _onOpenAutoFocus, ...props }, ref) {
      return (
        <div ref={ref} {...props}>
          {children}
        </div>
      )
    }),
    DialogDescription: Section,
    DialogFooter: Section,
    DialogHeader: Section,
    DialogTitle: Section
  }
})

vi.mock('@/lib/feedback-image-attachments', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    readFeedbackImageFiles: mocks.readFeedbackImageFiles
  }
})

vi.mock('@/store/index', async () => import('./sidebar-feedback-draft.test-fixture'))

import { SidebarFeedbackDialog } from './SidebarFeedbackDialog'
import { useAppStore } from '@/store/index'

beforeEach(() => {
  mocks.readFeedbackImageFiles.mockReset()
  mocks.submit.mockReset()
  mocks.toastWarning.mockReset()
  mocks.getPlatform.mockReset()
  mocks.getVersion.mockReset()
  mocks.submit.mockResolvedValue({ ok: true })
  mocks.getPlatform.mockReturnValue({
    platform: 'darwin',
    osRelease: '25.0.0',
    arch: 'arm64',
    shell: '/bin/zsh',
    displayServer: null
  })
  mocks.getVersion.mockResolvedValue('1.4.178-rc.2')
  URL.revokeObjectURL = vi.fn()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      feedback: { submit: mocks.submit },
      gh: { viewer: vi.fn().mockResolvedValue(null) },
      shell: { openUrl: vi.fn() },
      platform: {
        get: mocks.getPlatform
      },
      updater: { getVersion: mocks.getVersion }
    }
  })
})

afterEach(() => {
  cleanup()
  // The draft intentionally outlives dialogs; clear the store between tests.
  useAppStore.getState().clearFeedbackDraft()
})

describe('SidebarFeedbackDialog environment prefill', () => {
  it('preserves early typing and appends the footer after version loading finishes', async () => {
    let finishVersion: ((version: string) => void) | undefined
    mocks.getVersion.mockReturnValue(
      new Promise((resolve) => {
        finishVersion = resolve
      })
    )
    render(<SidebarFeedbackDialog open onOpenChange={vi.fn()} />)
    const textarea = screen.getByPlaceholderText('What could we improve?') as HTMLTextAreaElement

    fireEvent.change(textarea, { target: { value: 'Typed before loading' } })
    textarea.focus()
    textarea.setSelectionRange(textarea.value.length, textarea.value.length)
    await act(async () => finishVersion?.('1.4.178-rc.2'))

    await waitFor(() => expect(textarea.value).toContain('Orca: 1.4.178-rc.2'))
    expect(textarea.value).toContain('Typed before loading')
    expect(textarea.selectionStart).toBe('Typed before loading'.length)
  })
})

describe('SidebarFeedbackDialog image submission', () => {
  it('preserves pasted text while a mixed pending batch can fill the byte budget', async () => {
    const user = userEvent.setup()
    let finishFirstRead: ((value: unknown) => void) | undefined
    mocks.readFeedbackImageFiles
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finishFirstRead = resolve
        })
      )
      .mockResolvedValueOnce({ images: [], errors: ['No room for second.png'], notices: [] })
    const { container } = render(<SidebarFeedbackDialog open onOpenChange={vi.fn()} />)
    const textarea = screen.getByPlaceholderText<HTMLTextAreaElement>('What could we improve?')
    await waitFor(() => expect(textarea.value).toContain('Orca:'))
    fireEvent.change(textarea, { target: { value: 'before after' } })
    const retina = new File(['x'], 'retina.png', { type: 'image/png' })
    const gif = new File(['x'], 'anim.gif', { type: 'image/gif' })
    Object.defineProperty(retina, 'size', { value: 6_400_000 })
    Object.defineProperty(gif, 'size', { value: 2_444_304 })
    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: { files: [retina, gif] }
    })
    await waitFor(() => expect(mocks.readFeedbackImageFiles).toHaveBeenCalledTimes(1))
    textarea.focus()
    textarea.setSelectionRange(7, 7)
    const clipboard = new DataTransfer()
    clipboard.setData('text/plain', 'report')
    const second = new File(['x'], 'second.png', { type: 'image/png' })
    Object.defineProperty(second, 'size', { value: 1_500_000 })
    Object.defineProperty(clipboard, 'files', { value: [second] })

    await user.paste(clipboard)
    expect(textarea.value).toBe('before reportafter')
    await user.keyboard('!')
    expect(textarea.value).toBe('before report!after')
    await act(async () =>
      finishFirstRead?.({
        images: [
          {
            id: 'retina',
            name: 'retina.png',
            contentType: 'image/png',
            bytes: 1_750_000,
            data: new Uint8Array([1]),
            previewUrl: 'blob:retina'
          },
          {
            id: 'gif',
            name: 'anim.gif',
            contentType: 'image/gif',
            bytes: 2_444_304,
            data: new Uint8Array([1]),
            previewUrl: 'blob:gif'
          }
        ],
        errors: [],
        notices: []
      })
    )
    await waitFor(() => expect(mocks.readFeedbackImageFiles).toHaveBeenCalledTimes(2))
    expect(mocks.readFeedbackImageFiles).toHaveBeenNthCalledWith(2, [second], 2, 4_194_304)
    expect(textarea.value).toBe('before report!after')
    expect(textarea.selectionStart).toBe(14)
  })
})

describe('SidebarFeedbackDialog draft survival', () => {
  const REPORT = 'The terminal froze right after a rebase'

  function textarea(): HTMLTextAreaElement {
    return screen.getByPlaceholderText<HTMLTextAreaElement>('What could we improve?')
  }

  // Submission can finish after sidebar unmount; clear delivered drafts to avoid duplicate sends.
  it('clears the draft when the sidebar unmounts before the submit resolves', async () => {
    let resolveSubmit: ((result: { ok: true }) => void) | undefined
    mocks.submit.mockReturnValue(
      new Promise<{ ok: true }>((resolve) => {
        resolveSubmit = resolve
      })
    )
    const { unmount } = render(<SidebarFeedbackDialog open onOpenChange={vi.fn()} />)
    fireEvent.change(textarea(), { target: { value: REPORT } })

    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(mocks.submit).toHaveBeenCalled())
    unmount()
    await act(async () => {
      resolveSubmit?.({ ok: true })
    })

    expect(useAppStore.getState().feedbackDraft.feedback).toBe('')
  })

  // Stale unmounted handlers must preserve different text typed after reopening.
  it('keeps a report typed after remount while the previous submit is still in flight', async () => {
    const SECOND_REPORT = 'Different bug, typed after reopening the dialog'
    let resolveSubmit: ((result: { ok: true }) => void) | undefined
    mocks.submit.mockReturnValue(
      new Promise<{ ok: true }>((resolve) => {
        resolveSubmit = resolve
      })
    )
    const first = render(<SidebarFeedbackDialog open onOpenChange={vi.fn()} />)
    fireEvent.change(textarea(), { target: { value: REPORT } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(mocks.submit).toHaveBeenCalled())
    first.unmount()

    render(<SidebarFeedbackDialog open onOpenChange={vi.fn()} />)
    fireEvent.change(textarea(), { target: { value: SECOND_REPORT } })
    await act(async () => {
      resolveSubmit?.({ ok: true })
    })

    expect(useAppStore.getState().feedbackDraft.feedback).toContain(SECOND_REPORT)
    expect(textarea().value).toContain(SECOND_REPORT)
  })
})

// @vitest-environment happy-dom

import React, { act, type ReactNode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  readFeedbackImageFiles: vi.fn(),
  submit: vi.fn(),
  toastWarning: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
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

import { SidebarFeedbackDialog } from './SidebarFeedbackDialog'

beforeEach(() => {
  mocks.readFeedbackImageFiles.mockReset()
  mocks.submit.mockReset()
  mocks.toastWarning.mockReset()
  mocks.submit.mockResolvedValue({ ok: true })
  URL.revokeObjectURL = vi.fn()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      feedback: { submit: mocks.submit },
      gh: { viewer: vi.fn().mockResolvedValue(null) },
      shell: { openUrl: vi.fn() }
    }
  })
})

afterEach(() => {
  cleanup()
})

describe('SidebarFeedbackDialog image submission', () => {
  it('keeps the dialog scrollable within short windows', () => {
    const { container } = render(<SidebarFeedbackDialog open onOpenChange={vi.fn()} />)
    const content = container.querySelector('.scrollbar-sleek')

    expect(content?.className).toContain('max-h-[calc(100vh-3rem)]')
    expect(content?.className).toContain('overflow-y-auto')
  })

  it('waits for in-flight image reads before enabling Send', async () => {
    let finishRead: ((value: unknown) => void) | undefined
    mocks.readFeedbackImageFiles.mockReturnValue(
      new Promise((resolve) => {
        finishRead = resolve
      })
    )
    const { container } = render(<SidebarFeedbackDialog open onOpenChange={vi.fn()} />)
    fireEvent.change(screen.getByPlaceholderText('What could we improve?'), {
      target: { value: 'Screenshot attached' }
    })
    const file = new File(['image'], 'shot.png', { type: 'image/png' })
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')
    expect(input).not.toBeNull()
    fireEvent.change(input!, { target: { files: [file] } })

    const send = screen.getByRole('button', { name: 'Send' })
    expect((send as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(send)
    expect(mocks.submit).not.toHaveBeenCalled()

    await act(async () => {
      finishRead?.({
        images: [
          {
            id: 'shot',
            name: file.name,
            contentType: file.type,
            bytes: file.size,
            data: new Uint8Array([1]),
            previewUrl: 'blob:shot'
          }
        ],
        errors: []
      })
    })

    await waitFor(() => expect((send as HTMLButtonElement).disabled).toBe(false))
    const remove = screen.getByRole('button', { name: 'Remove shot.png' })
    expect(remove.dataset.slot).toBe('button')
    expect(remove.dataset.size).toBe('icon-xs')
    fireEvent.click(send)
    await waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(1))
    expect(mocks.submit.mock.calls[0]?.[0].images).toEqual([
      { contentType: 'image/png', data: new Uint8Array([1]) }
    ])
  })

  it('warns when the server cannot confirm image delivery', async () => {
    mocks.readFeedbackImageFiles.mockResolvedValue({
      images: [
        {
          id: 'shot',
          name: 'shot.png',
          contentType: 'image/png',
          bytes: 1,
          data: new Uint8Array([1]),
          previewUrl: 'blob:shot'
        }
      ],
      errors: []
    })
    mocks.submit.mockResolvedValue({ ok: true, imagesDelivered: false })
    const onOpenChange = vi.fn()
    const { container } = render(<SidebarFeedbackDialog open onOpenChange={onOpenChange} />)
    fireEvent.change(screen.getByPlaceholderText('What could we improve?'), {
      target: { value: 'Screenshot attached' }
    })
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')
    fireEvent.change(input!, {
      target: { files: [new File(['x'], 'shot.png', { type: 'image/png' })] }
    })
    await screen.findByRole('button', { name: 'Remove shot.png' })

    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() =>
      expect(mocks.toastWarning).toHaveBeenCalledWith(
        'Feedback sent, but image delivery could not be confirmed.'
      )
    )
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('releases image previews when the sidebar unmounts the dialog', async () => {
    mocks.readFeedbackImageFiles.mockResolvedValue({
      images: [
        {
          id: 'shot',
          name: 'shot.png',
          contentType: 'image/png',
          bytes: 1,
          data: new Uint8Array([1]),
          previewUrl: 'blob:shot'
        }
      ],
      errors: []
    })
    const { container, unmount } = render(<SidebarFeedbackDialog open onOpenChange={vi.fn()} />)
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')
    fireEvent.change(input!, {
      target: { files: [new File(['x'], 'shot.png', { type: 'image/png' })] }
    })
    await screen.findByRole('button', { name: 'Remove shot.png' })

    unmount()

    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:shot')
  })

  it('does not consume text when the pasted image cannot be attached', () => {
    mocks.readFeedbackImageFiles.mockResolvedValue({
      images: [],
      errors: ['huge.png is larger than 8.0 MB.']
    })
    render(<SidebarFeedbackDialog open onOpenChange={vi.fn()} />)
    const textarea = screen.getByPlaceholderText('What could we improve?')
    const file = new File(['image'], 'huge.png', { type: 'image/png' })
    Object.defineProperty(file, 'size', { value: 8 * 1024 * 1024 + 1 })
    const paste = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(paste, 'clipboardData', {
      value: { files: [file] }
    })

    fireEvent(textarea, paste)

    expect(paste.defaultPrevented).toBe(false)
    expect(mocks.readFeedbackImageFiles).toHaveBeenCalledWith([file], 0)
  })

  it('rejects images added after submission starts instead of clearing them unsent', async () => {
    mocks.submit.mockReturnValue(new Promise(() => {}))
    const { container } = render(<SidebarFeedbackDialog open onOpenChange={vi.fn()} />)
    fireEvent.change(screen.getByPlaceholderText('What could we improve?'), {
      target: { value: 'Initial report' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(1))
    const file = new File(['image'], 'late.png', { type: 'image/png' })
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')

    fireEvent.change(input!, { target: { files: [file] } })

    expect(mocks.readFeedbackImageFiles).not.toHaveBeenCalled()
    expect(mocks.toastWarning).toHaveBeenCalledWith(
      'Wait for the current feedback to finish sending before attaching more images.'
    )
  })
})

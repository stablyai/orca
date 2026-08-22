// @vitest-environment happy-dom

import React, { act, type ReactNode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
})

describe('SidebarFeedbackDialog environment prefill', () => {
  it('pre-inserts Orca version and OS info when the dialog opens', async () => {
    render(<SidebarFeedbackDialog open onOpenChange={vi.fn()} />)
    const textarea = screen.getByPlaceholderText('What could we improve?') as HTMLTextAreaElement

    await waitFor(() => {
      expect(textarea.value).toContain('Orca: 1.4.178-rc.2')
      expect(textarea.value).toContain('OS: darwin 25.0.0 (arm64)')
      expect(textarea.value).toContain('Shell: /bin/zsh')
    })
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('keeps version info when the user types above the prefilled block', async () => {
    render(<SidebarFeedbackDialog open onOpenChange={vi.fn()} />)
    const textarea = screen.getByPlaceholderText('What could we improve?') as HTMLTextAreaElement
    await waitFor(() => expect(textarea.value).toContain('Orca: 1.4.178-rc.2'))

    fireEvent.change(textarea, {
      target: { value: `Tabs feel slow\n\n${textarea.value.trim()}` }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(1))
    const submitted = mocks.submit.mock.calls[0]?.[0].feedback as string
    expect(submitted).toContain('Tabs feel slow')
    expect(submitted).toContain('Orca: 1.4.178-rc.2')
  })

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

  it('enables Send when the user types below the prefilled footer', async () => {
    render(<SidebarFeedbackDialog open onOpenChange={vi.fn()} />)
    const textarea = screen.getByPlaceholderText('What could we improve?') as HTMLTextAreaElement
    await waitFor(() => expect(textarea.value).toContain('Orca: 1.4.178-rc.2'))

    fireEvent.change(textarea, {
      target: { value: `${textarea.value.trim()}\nText below footer` }
    })

    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('keeps Send disabled for an edited footer with no user text', async () => {
    render(<SidebarFeedbackDialog open onOpenChange={vi.fn()} />)
    const textarea = screen.getByPlaceholderText('What could we improve?') as HTMLTextAreaElement
    await waitFor(() => expect(textarea.value).toContain('Orca: 1.4.178-rc.2'))

    fireEvent.change(textarea, {
      target: { value: '---\nOrca: custom build\nOS: edited' }
    })

    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('allows a real report after the prefilled footer is deleted', async () => {
    render(<SidebarFeedbackDialog open onOpenChange={vi.fn()} />)
    const textarea = screen.getByPlaceholderText('What could we improve?') as HTMLTextAreaElement
    await waitFor(() => expect(textarea.value).toContain('Orca: 1.4.178-rc.2'))
    const send = screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement

    fireEvent.change(textarea, { target: { value: '' } })
    expect(send.disabled).toBe(true)
    fireEvent.change(textarea, { target: { value: 'Tabs hang after waking the laptop.' } })
    expect(send.disabled).toBe(false)
  })

  it('still prefills best-effort details when preload lookups fail', async () => {
    mocks.getPlatform.mockImplementation(() => {
      throw new Error('platform unavailable')
    })
    mocks.getVersion.mockRejectedValue(new Error('version unavailable'))

    render(<SidebarFeedbackDialog open onOpenChange={vi.fn()} />)

    await waitFor(() => {
      const textarea = screen.getByPlaceholderText('What could we improve?') as HTMLTextAreaElement
      expect(textarea.value).toContain('Orca: unknown')
    })
  })
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

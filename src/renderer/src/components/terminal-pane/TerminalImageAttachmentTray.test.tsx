// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TerminalImageAttachmentTray } from './TerminalImageAttachmentTray'
import {
  requestTerminalImageAttachment,
  type TerminalImageAttachmentRequest
} from './terminal-image-attachment-request'
import { pasteTerminalClipboard } from './terminal-clipboard-paste'

vi.mock('../native-chat/NativeChatImageAttachmentPreview', () => ({
  NativeChatImageAttachmentPreview: ({
    attachment,
    onRemove,
    removeDisabled
  }: {
    attachment: { id: string; path: string }
    onRemove: (id: string) => void
    removeDisabled?: boolean
  }) => (
    <button disabled={removeDisabled} onClick={() => onRemove(attachment.id)}>
      Remove {attachment.path}
    </button>
  )
}))

function request(id = 'one'): TerminalImageAttachmentRequest {
  return {
    attachment: { id, path: `/tmp/${id}.png` },
    attach: vi.fn(async () => true),
    cancel: vi.fn(),
    isCurrent: () => true
  }
}
function setup() {
  const container = document.createElement('div')
  const view = render(<TerminalImageAttachmentTray container={container} />)
  const stage = (item: TerminalImageAttachmentRequest) => {
    let accepted = false
    act(() => {
      accepted = requestTerminalImageAttachment(container, item)
    })
    return accepted
  }
  return { container, view, stage }
}

afterEach(cleanup)

describe('terminal image attachment staging', () => {
  it('stages clipboard images without writing to the terminal and leaves text paste unchanged', async () => {
    const pasteText = vi.fn()
    const stageImage = vi.fn(() => true)
    const deps = {
      readClipboardText: vi.fn(async () => ''),
      saveClipboardImageAsTempFile: vi.fn(async () => '/tmp/one.png'),
      pasteText,
      stageImage
    }
    expect(await pasteTerminalClipboard(deps)).toEqual({ status: 'staged', kind: 'image-path' })
    expect(pasteText).not.toHaveBeenCalled()
    deps.readClipboardText.mockResolvedValue('draft')
    await pasteTerminalClipboard(deps)
    expect(pasteText).toHaveBeenCalledWith('draft')
    expect(stageImage).toHaveBeenCalledTimes(1)
  })
  it('does not inject automatically when staging is rejected or the listener is absent', async () => {
    const pasteText = vi.fn()
    expect(requestTerminalImageAttachment(document.createElement('div'), request())).toBe(false)
    expect(
      await pasteTerminalClipboard({
        readClipboardText: async () => '',
        saveClipboardImageAsTempFile: async () => '/tmp/one.png',
        stageImage: () => false,
        pasteText
      })
    ).toEqual({ status: 'skipped', reason: 'image-paste-rejected' })
    expect(pasteText).not.toHaveBeenCalled()
  })
  it('removes and cancels without injecting, then allows a new paste', () => {
    const { stage } = setup()
    const first = request()
    expect(stage(first)).toBe(true)
    fireEvent.click(screen.getByText('Remove /tmp/one.png'))
    expect(first.cancel).toHaveBeenCalledOnce()
    expect(first.attach).not.toHaveBeenCalled()
    stage(request('two'))
    fireEvent.click(screen.getByText('Cancel'))
    expect(screen.queryByText('Remove /tmp/two.png')).toBeNull()
  })
  it('injects only on explicit confirmation and clears successful items', async () => {
    const { stage } = setup()
    const item = request()
    stage(item)
    expect(item.attach).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Add to Codex'))
    await waitFor(() => expect(screen.queryByText('Add to Codex')).toBeNull())
    expect(item.attach).toHaveBeenCalledOnce()
  })
  it('keeps failed items for retry without resending successful ones', async () => {
    const { stage } = setup()
    const first = request('first')
    const second = request('second')
    second.attach = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    stage(first)
    stage(second)
    fireEvent.click(screen.getByText('Add to Codex'))
    await screen.findByRole('alert')
    expect(screen.queryByText('Remove /tmp/first.png')).toBeNull()
    fireEvent.click(screen.getByText('Add to Codex'))
    await waitFor(() => expect(screen.queryByText('Add to Codex')).toBeNull())
    expect(first.attach).toHaveBeenCalledOnce()
    expect(second.attach).toHaveBeenCalledTimes(2)
  })
  it('cancels pending requests on navigation or a scope-key remount', () => {
    const { stage, view, container } = setup()
    const item = request()
    stage(item)
    view.rerender(<TerminalImageAttachmentTray key="next-session" container={container} />)
    expect(item.cancel).toHaveBeenCalledOnce()
    expect(screen.queryByText('Add to Codex')).toBeNull()
    expect(item.attach).not.toHaveBeenCalled()
  })
  it('rejects stale requests and bounds the tray at four attachments', () => {
    const { stage } = setup()
    expect(stage({ ...request(), isCurrent: () => false })).toBe(false)
    for (let i = 0; i < 4; i++) {
      expect(stage(request(String(i)))).toBe(true)
    }
    expect(stage(request('overflow'))).toBe(false)
  })
  it('refuses stale admission at confirmation and retains an error', async () => {
    const { stage } = setup()
    const item = request()
    let current = true
    item.isCurrent = () => current
    stage(item)
    current = false
    fireEvent.click(screen.getByText('Add to Codex'))
    await screen.findByRole('alert')
    expect(item.attach).not.toHaveBeenCalled()
  })
})

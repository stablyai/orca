// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatComposerInput } from '../../composer/editor/native-chat-composer-input'
import {
  NativeChatPaneFileDropSurface,
  useNativeChatPaneFileDropClaim
} from './NativeChatPaneFileDropSurface'
import { NativeChatPromptEditor } from '../../composer/editor/NativeChatPromptEditor'

const electron = vi.hoisted(() => ({
  on: vi.fn(),
  removeListener: vi.fn(),
  send: vi.fn(),
  getPathForFile: vi.fn((file: File) => `/drop/${file.name}`)
}))
vi.mock('electron', () => ({
  ipcRenderer: electron,
  webUtils: { getPathForFile: electron.getPathForFile }
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

const prepare = vi.fn(async ({ paths }: { paths: string[] }) => ({ paths, failures: [] }))
function Composer({
  attach,
  disabled = false
}: {
  attach: (paths: string[]) => void
  disabled?: boolean
}) {
  const input = useRef<NativeChatComposerInput>(null)
  useNativeChatPaneFileDropClaim({
    destinationKey: 'draft',
    disabled,
    onDragOverCapture: () => {},
    onDropCapture: () => {},
    captureExternalDrop: () => async (paths) => attach(paths)
  })
  return (
    <NativeChatPromptEditor
      scopeKey="draft"
      inputRef={input}
      initialValue="Original"
      disabled={disabled}
      placeholder="Message"
      onChange={() => {}}
      onSelect={() => {}}
    />
  )
}
function Chat({
  attach,
  hidden = false,
  disabled = false
}: {
  attach: (paths: string[]) => void
  hidden?: boolean
  disabled?: boolean
}) {
  return (
    <div style={{ display: hidden ? 'none' : 'block' }}>
      <NativeChatPaneFileDropSurface className="chat">
        <Composer attach={attach} disabled={disabled} />
      </NativeChatPaneFileDropSurface>
    </div>
  )
}
async function drop(target: Element, types = ['Files']) {
  const event = new Event('drop', { bubbles: true, cancelable: true, composed: true })
  Object.defineProperty(event, 'isTrusted', { value: true })
  Object.defineProperty(event, 'dataTransfer', {
    value: {
      types,
      files: [new File(['x'], 'a.png')],
      getData: (type: string) => (type === 'text/html' ? '<b>Injected</b>' : '')
    }
  })
  await act(async () => {
    target.dispatchEvent(event)
  })
  return event
}
function dragEvent(target: Element, type: string, transfer: { dropEffect: string }): Event {
  const event = new Event(type, { bubbles: true, cancelable: true, composed: true })
  Object.defineProperty(event, 'isTrusted', { value: true })
  Object.defineProperty(event, 'dataTransfer', { value: transfer })
  target.dispatchEvent(event)
  return event
}
function negotiateAndRelease(target: Element) {
  const transfer = { types: ['Files'], files: [new File(['x'], 'a.png')], dropEffect: 'move' }
  const hover = dragEvent(target, 'dragover', transfer)
  const release = dragEvent(target, transfer.dropEffect === 'none' ? 'dragleave' : 'drop', transfer)
  return { hover, release, transfer }
}
function AvailabilityComposer({ attach }: { attach: (paths: string[]) => void }) {
  const [disabled, setDisabled] = useState(true)
  return (
    <>
      <button onClick={() => setDisabled((value) => !value)}>Toggle availability</button>
      <Composer attach={attach} disabled={disabled} />
    </>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('api', {
    fs: { getPathForFile: electron.getPathForFile, prepareDroppedPaths: prepare }
  })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('element-owned native chat drops', () => {
  it('claims a portaled chat while refusing the unowned container around it', async () => {
    const attach = vi.fn()
    const terminal = document.createElement('div')
    document.body.append(terminal)
    const terminalDrop = vi.fn()
    terminal.addEventListener('drop', terminalDrop)
    try {
      render(createPortal(<Chat attach={attach} />, terminal))
      await drop(terminal.querySelector('.ProseMirror')!)
      expect(attach).toHaveBeenCalledExactlyOnceWith(['/drop/a.png'])
      expect(terminalDrop).not.toHaveBeenCalled()
      expect(electron.send).not.toHaveBeenCalled()
      await drop(terminal)
      expect(electron.send).not.toHaveBeenCalled()
      expect(attach).toHaveBeenCalledOnce()
    } finally {
      terminal.remove()
    }
  })
  it('reads child-only availability changes on the immediate dragover and drop', async () => {
    const attach = vi.fn()
    const view = render(
      <NativeChatPaneFileDropSurface className="chat">
        <AvailabilityComposer attach={attach} />
      </NativeChatPaneFileDropSurface>
    )
    const target = view.container.querySelector('.ProseMirror')!
    const refused = negotiateAndRelease(target)
    expect(refused.transfer.dropEffect).toBe('none')
    expect(prepare).not.toHaveBeenCalled()
    fireEvent.click(view.getByText('Toggle availability'))
    let accepted: ReturnType<typeof negotiateAndRelease> | undefined
    await act(async () => {
      accepted = negotiateAndRelease(target)
    })
    expect(accepted?.transfer.dropEffect).toBe('copy')
    expect(accepted?.release.type).toBe('drop')
    expect(attach).toHaveBeenCalledExactlyOnceWith(['/drop/a.png'])
    fireEvent.click(view.getByText('Toggle availability'))
    await drop(target)
    expect(attach).toHaveBeenCalledOnce()
    expect(prepare).toHaveBeenCalledOnce()
    expect(electron.send).not.toHaveBeenCalled()
  })
})

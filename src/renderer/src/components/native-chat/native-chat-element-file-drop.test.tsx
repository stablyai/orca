// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import type { NativeChatComposerInput } from './native-chat-composer-input'
import {
  NativeChatPaneFileDropSurface,
  useNativeChatPaneFileDropClaim
} from './NativeChatPaneFileDropSurface'
import { NativeChatPromptEditor } from './NativeChatPromptEditor'
import { useNewWorkspaceComposerFileDrop } from '../new-workspace/use-new-workspace-composer-file-drop'

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
import { installNativeFileDropHandlers } from '../../../../preload/preload-runtime-support'

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
function WorkspaceWithoutPath({ attach }: { attach: () => Promise<void> }) {
  const owner = useNewWorkspaceComposerFileDrop({
    projectPath: null,
    hostId: 'local',
    connectionId: null,
    applyDrop: attach
  })
  return <div ref={owner} className="workspace-card" />
}
beforeAll(() => installNativeFileDropHandlers())
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
  it('attaches to visible chat A while mounted chat B is hidden, without scope markers', async () => {
    const a = vi.fn()
    const b = vi.fn()
    const view = render(
      <>
        <Chat attach={a} />
        <Chat attach={b} hidden />
      </>
    )
    const target = view.container.querySelector('.ProseMirror')!
    await drop(target)
    expect(a).toHaveBeenCalledExactlyOnceWith(['/drop/a.png'])
    expect(b).not.toHaveBeenCalled()
    expect(view.container.querySelector('[data-composer-scope-key]')).toBeNull()
    expect(electron.send).not.toHaveBeenCalled()
  })
  it('shows the attachment overlay on dragover while the chat can accept files', async () => {
    const attach = vi.fn()
    const view = render(<Chat attach={attach} />)
    const target = view.container.querySelector('.ProseMirror')!
    const transfer = { types: ['Files'], dropEffect: 'move' }
    await act(async () => dragEvent(target, 'dragover', transfer))
    expect(transfer.dropEffect).toBe('copy')
    expect(view.getByText('Drop to attach to this chat')).toBeTruthy()
    await drop(target)
    expect(view.queryByText('Drop to attach to this chat')).toBeNull()
    expect(attach).toHaveBeenCalledExactlyOnceWith(['/drop/a.png'])
  })
  it('claims a portaled chat inside a legacy terminal while the terminal outside stays legacy exactly once', async () => {
    const attach = vi.fn()
    const terminal = document.createElement('div')
    terminal.dataset.nativeFileDropTarget = 'terminal'
    terminal.dataset.terminalTabId = 'terminal-a'
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
      expect(electron.send).toHaveBeenCalledExactlyOnceWith('terminal:file-dropped-from-preload', {
        target: 'terminal',
        tabId: 'terminal-a',
        paths: ['/drop/a.png']
      })
      expect(attach).toHaveBeenCalledOnce()
    } finally {
      terminal.remove()
    }
  })
  it.each([false, true])(
    'refuses by cursor only through dragover and release when composer disabled is %s',
    async (disabled) => {
      const attach = vi.fn()
      const view = render(
        <div data-native-file-drop-target="terminal">
          <NativeChatPaneFileDropSurface className="chat">
            {disabled ? <Composer attach={attach} disabled /> : <span>Question</span>}
          </NativeChatPaneFileDropSurface>
        </div>
      )
      const target = view.container.querySelector('.chat')!
      let gesture: ReturnType<typeof negotiateAndRelease> | undefined
      await act(async () => {
        gesture = negotiateAndRelease(target)
      })
      expect(gesture?.hover.defaultPrevented).toBe(true)
      expect(gesture?.transfer.dropEffect).toBe('none')
      expect(gesture?.release.type).toBe('dragleave')
      // A late delivered drop must preserve the same silent refusal barrier.
      await drop(target)
      expect(toast.error).not.toHaveBeenCalled()
      expect(attach).not.toHaveBeenCalled()
      expect(prepare).not.toHaveBeenCalled()
      expect(electron.send).not.toHaveBeenCalled()
    }
  )
  it('keeps a workspace card without a path silent and out of the legacy terminal relay', async () => {
    const attach = vi.fn(async () => {})
    const view = render(
      <div data-native-file-drop-target="terminal">
        <WorkspaceWithoutPath attach={attach} />
      </div>
    )
    const target = view.container.querySelector('.workspace-card')!
    let gesture: ReturnType<typeof negotiateAndRelease> | undefined
    await act(async () => {
      gesture = negotiateAndRelease(target)
    })
    expect(gesture?.hover.defaultPrevented).toBe(true)
    expect(gesture?.transfer.dropEffect).toBe('none')
    expect(gesture?.release.type).toBe('dragleave')
    await drop(target)
    expect(attach).not.toHaveBeenCalled()
    expect(prepare).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
    expect(electron.send).not.toHaveBeenCalled()
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
  it('attaches hybrid Files and HTML without inserting HTML into the real editor', async () => {
    const attach = vi.fn()
    const view = render(<Chat attach={attach} />)
    const editor = view.container.querySelector('.ProseMirror')!
    await drop(editor, ['Files', 'text/html'])
    expect(attach).toHaveBeenCalledExactlyOnceWith(['/drop/a.png'])
    expect(editor.textContent).toBe('Original')
    expect(editor.querySelector('b')).toBeNull()
  })
})

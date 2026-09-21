// @vitest-environment happy-dom

import { terminalHarness } from './__mocks__/preview-terminal-input'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentTerminalPreview } from './AgentTerminalPreview'
import { captureInsertionTarget, insertText } from '../dictation/dictation-insertion-target'
import type { TerminalPreviewDataPayload } from '../../../../shared/terminal-preview'
import { TERMINAL_PASTE_DIRECT_MAX_BYTES } from '../terminal-pane/terminal-paste-limits'
import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START
} from '../terminal-pane/terminal-bracketed-paste'
import type { DashboardCardTerminalInput } from '../../../../shared/dashboard-snapshot'

const input = vi.fn(async (_ptyId: string, _data: string) => true)
const connect = vi.fn(async () => ({
  snapshot: { data: '', cols: 80, rows: 24, seq: 1 },
  replay: []
}))
const dataListeners = new Set<(payload: TerminalPreviewDataPayload) => void>()

beforeEach(() => {
  terminalHarness.instances.length = 0
  input.mockImplementation(async () => true)
  Object.assign(window, {
    api: {
      terminalPreview: {
        connect,
        input,
        fit: vi.fn(async (_ptyId: string, cols: number, rows: number) => ({ cols, rows })),
        ack: vi.fn(),
        unsubscribe: vi.fn(),
        onData: (listener: (payload: TerminalPreviewDataPayload) => void) => {
          dataListeners.add(listener)
          return () => dataListeners.delete(listener)
        }
      }
    }
  })
})

afterEach(() => {
  cleanup()
  dataListeners.clear()
  vi.clearAllMocks()
})

function capturePreview(
  container: HTMLElement
): NonNullable<ReturnType<typeof captureInsertionTarget>> {
  focusPreview(container)
  const target = captureInsertionTarget()
  if (!target) {
    throw new Error('No dictation target')
  }
  return target
}

it.each(['unmount', 'replace-pty'] as const)(
  'invalidates the destination on %s',
  async (change) => {
    const view = render(<AgentTerminalPreview ptyId="pty-a" />)
    await waitFor(() => expect(terminalHarness.instances).toHaveLength(1))
    const target = capturePreview(view.container)
    if (change === 'unmount') {
      view.unmount()
      render(<AgentTerminalPreview ptyId="pty-a" />)
    } else {
      view.rerender(<AgentTerminalPreview ptyId="pty-b" />)
    }
    await waitFor(() => expect(terminalHarness.instances).toHaveLength(2))
    await act(async () => insertText('stale text', target))
    expect(input).not.toHaveBeenCalled()
    for (const terminal of terminalHarness.instances) {
      expect(terminal.paste).not.toHaveBeenCalled()
    }
  }
)

it('invalidates a capture during reconnect and permits a fresh capture afterwards', async () => {
  const view = render(<AgentTerminalPreview ptyId="pty-a" />)
  await waitFor(() => expect(terminalHarness.instances).toHaveLength(1))
  const target = capturePreview(view.container)
  await act(async () => {
    for (const listener of dataListeners) {
      listener({ type: 'resync', ptyId: 'pty-a' })
    }
    expect(captureInsertionTarget()).toBeNull()
    insertText('during reconnect', target)
  })
  expect(connect).toHaveBeenCalledTimes(2)
  await act(async () => insertText('after reconnect', target))
  expect(input).not.toHaveBeenCalled()
  const freshTarget = capturePreview(view.container)
  await act(async () => insertText('fresh text', freshTarget))
  expect(input).toHaveBeenCalledExactlyOnceWith('pty-a', 'fresh text')
})

const remoteInput: DashboardCardTerminalInput = {
  hostPlatform: 'win32',
  localWindowsConpty: false,
  windowsShiftEnterEncoding: 'alt-enter',
  windowsInputRecordPasteNewline: 'csi-u',
  ctrlEnterCsiU: false,
  kittyKeyboardAdvertised: false,
  connectionId: 'remote-a'
}

it('uses the captured SSH destination and host newline policy', async () => {
  const view = render(
    <AgentTerminalPreview ptyId="ssh:remote-a@@pty-1" terminalInput={remoteInput} />
  )
  await waitFor(() => expect(terminalHarness.instances).toHaveLength(1))
  const target = capturePreview(view.container)
  await act(async () => insertText('first\nsecond', target))
  expect(input).toHaveBeenCalledExactlyOnceWith('ssh:remote-a@@pty-1', 'first\x1b[13;2usecond')
})

it('rejects a destination whose execution host changed', async () => {
  const view = render(<AgentTerminalPreview ptyId="pty-1" terminalInput={remoteInput} />)
  await waitFor(() => expect(terminalHarness.instances).toHaveLength(1))
  const target = capturePreview(view.container)
  view.rerender(
    <AgentTerminalPreview
      ptyId="pty-1"
      terminalInput={{ ...remoteInput, connectionId: 'remote-b' }}
    />
  )
  await act(async () => insertText('stale host', target))
  expect(input).not.toHaveBeenCalled()
})

it('stops chunked dictation on unmount and closes the original paste frame', async () => {
  const view = render(<AgentTerminalPreview ptyId="pty-a" />)
  await waitFor(() => expect(terminalHarness.instances).toHaveLength(1))
  const target = capturePreview(view.container)
  terminalHarness.instances[0].modes.bracketedPasteMode = true
  input.mockImplementationOnce(async () => {
    view.unmount()
    return true
  })
  await act(async () => insertText('x'.repeat(TERMINAL_PASTE_DIRECT_MAX_BYTES + 1), target))
  await waitFor(() => expect(input).toHaveBeenCalledTimes(2))
  expect(input.mock.calls).toEqual([
    ['pty-a', BRACKETED_PASTE_START],
    ['pty-a', BRACKETED_PASTE_END]
  ])
})

function focusPreview(container: HTMLElement): void {
  const host = container.querySelector('.origin-bottom-left')
  if (!host) {
    throw new Error('Missing preview container')
  }
  const textarea = document.createElement('textarea')
  textarea.className = 'xterm-helper-textarea'
  host.appendChild(textarea)
  textarea.focus()
}

it('dictates into the captured preview after another card takes focus', async () => {
  const first = render(<AgentTerminalPreview ptyId="pty-a" autoFocus={false} />)
  const second = render(<AgentTerminalPreview ptyId="pty-b" autoFocus={false} />)
  await waitFor(() => expect(terminalHarness.instances).toHaveLength(2))
  focusPreview(first.container)
  const target = captureInsertionTarget()
  expect(target).not.toBeNull()
  if (!target) {
    throw new Error('No dictation target')
  }
  focusPreview(second.container)

  await act(async () => insertText('dictated text', target))

  expect(terminalHarness.instances[0].paste).toHaveBeenCalledWith('dictated text')
  expect(terminalHarness.instances[1].paste).not.toHaveBeenCalled()
  expect(input).toHaveBeenCalledExactlyOnceWith('pty-a', 'dictated text')
})

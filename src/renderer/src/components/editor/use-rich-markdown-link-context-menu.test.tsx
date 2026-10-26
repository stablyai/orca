// @vitest-environment happy-dom

import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RichMarkdownContextMenuCommandPayload } from '../../../../shared/rich-markdown-context-menu'
import type * as HttpLinkDestinationsModule from '@/lib/http-link-destinations'
import type { HttpLinkSourceOwner } from '@/lib/http-link-routing'
import { useRichMarkdownLinkContextMenu } from './use-rich-markdown-link-context-menu'

const openRoutedHttpLink = vi.hoisted(() => vi.fn())
vi.mock('@/lib/http-link-destinations', async (importOriginal) => ({
  ...(await importOriginal<typeof HttpLinkDestinationsModule>()),
  openRoutedHttpLink
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('../native-chat/native-chat-http-link-source-owner', () => ({
  canNativeChatOpenOwnedBrowser: () => false
}))

function Harness({
  editor,
  sourceOwner
}: {
  editor: Parameters<typeof useRichMarkdownLinkContextMenu>[0]
  sourceOwner: HttpLinkSourceOwner
}): null {
  useRichMarkdownLinkContextMenu(editor, {
    getSnapshot: () => ({
      version: 0,
      sourceFilePath: '/repo/README.md',
      worktreeId: 'wt-1',
      worktreeRoot: '/repo',
      sourceOwner
    })
  })
  return null
}

function setup(sourceOwner: HttpLinkSourceOwner) {
  const editorDom = document.createElement('div')
  editorDom.innerHTML =
    '<p><a href="https://github.com/o/r/pull/1">PR</a> plain <a href="docs/a.md">doc</a></p>'
  document.body.append(editorDom)
  const setRichMarkdownContextMenuLinkTarget = vi.fn()
  const commandListeners: ((payload: RichMarkdownContextMenuCommandPayload) => void)[] = []
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      ui: {
        setRichMarkdownContextMenuLinkTarget,
        onRichMarkdownContextCommand: vi.fn((callback) => {
          commandListeners.push(callback)
          return vi.fn()
        })
      }
    }
  })
  render(<Harness editor={{ view: { dom: editorDom } }} sourceOwner={sourceOwner} />)
  const runCommand = (payload: RichMarkdownContextMenuCommandPayload): void =>
    commandListeners.forEach((listener) => listener(payload))
  return { editorDom, setRichMarkdownContextMenuLinkTarget, runCommand }
}

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  openRoutedHttpLink.mockClear()
})

describe('useRichMarkdownLinkContextMenu', () => {
  it('reports an Orca-openable link and opens it in Orca Browser from the native menu', () => {
    const { editorDom, setRichMarkdownContextMenuLinkTarget, runCommand } = setup({
      kind: 'local'
    })

    fireEvent.contextMenu(editorDom.querySelector('a')!, { clientX: 12, clientY: 34 })
    expect(setRichMarkdownContextMenuLinkTarget).toHaveBeenLastCalledWith({ x: 12, y: 34 })

    runCommand({ command: 'open-link-in-orca-browser', x: 12, y: 34 })
    expect(openRoutedHttpLink).toHaveBeenCalledWith('https://github.com/o/r/pull/1', {
      worktreeId: 'wt-1',
      sourceOwner: { kind: 'local' },
      forceDestination: 'orca'
    })
  })

  it('reports no Orca target off an http(s) link or when the remote source cannot reach Orca', () => {
    const local = setup({ kind: 'local' })
    fireEvent.contextMenu(local.editorDom.querySelector('a[href="docs/a.md"]')!)
    expect(local.setRichMarkdownContextMenuLinkTarget).toHaveBeenLastCalledWith(null)
    cleanup()

    const remote = setup({ kind: 'ssh', connectionId: 'conn-1' })
    fireEvent.contextMenu(remote.editorDom.querySelector('a')!, { clientX: 12, clientY: 34 })
    expect(remote.setRichMarkdownContextMenuLinkTarget).toHaveBeenLastCalledWith(null)
    remote.runCommand({ command: 'open-link-in-orca-browser', x: 12, y: 34 })
    expect(openRoutedHttpLink).not.toHaveBeenCalled()
  })
})

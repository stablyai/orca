// @vitest-environment happy-dom

import { act, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand/vanilla'
import type { AppState } from '@/store'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { createEditorStore } from './editor-autosave-controller-test-fixture'
import type { FileContent } from './editor-panel-content-types'
import {
  publishEditorBufferContent,
  useEditorBufferContentSync
} from './use-editor-buffer-content-sync'

const fixture = vi.hoisted((): { store: StoreApi<AppState> | null } => ({ store: null }))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => fixture.store?.getState() }
}))

type PanelHandle = {
  contents: Record<string, FileContent>
  set: (id: string, content: string) => void
}

function Panel({
  initial,
  handle,
  tracksRead
}: {
  initial: Record<string, FileContent>
  handle: PanelHandle
  tracksRead?: (fileId: string) => boolean
}) {
  const [contents, setContents] = useState(initial)
  const openFilesRef = useRef(fixture.store?.getState().openFiles ?? [])
  handle.contents = contents
  handle.set = (id, content) =>
    setContents((prev) => ({ ...prev, [id]: { content, isBinary: false } }))
  useEditorBufferContentSync(contents, setContents, openFilesRef, tracksRead)
  return null
}

let container: HTMLDivElement
let root: Root

function openTab(worktreeId: string): string {
  fixture.store?.getState().openFile({
    filePath: '/repo/a.ts',
    relativePath: 'a.ts',
    worktreeId,
    language: 'typescript',
    mode: 'edit'
  })
  return fixture.store?.getState().openFiles.at(-1)?.id ?? ''
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  fixture.store = createEditorStore()
  fixture.store.setState({
    worktreesByRepo: {
      'repo-1': [
        makeWorktree({ id: 'wt-1', repoId: 'repo-1', path: '/repo', hostId: 'local' }),
        makeWorktree({ id: 'wt-2', repoId: 'repo-1', path: '/repo', hostId: 'local' })
      ]
    }
  })
  container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

it("refreshes another panel's cached disk text for the same file after a reload", () => {
  const a = openTab('wt-1')
  const b = openTab('wt-2')
  const old = { content: 'old disk', isBinary: false }
  const panelA: PanelHandle = { contents: {}, set: () => {} }
  const panelB: PanelHandle = { contents: {}, set: () => {} }
  act(() =>
    root.render(
      <>
        <Panel initial={{ [a]: old }} handle={panelA} />
        <Panel initial={{ [b]: old }} handle={panelB} />
      </>
    )
  )

  act(() => panelA.set(a, 'reloaded disk'))

  expect(panelB.contents[b]?.content).toBe('reloaded disk')
})

it('fills a tab whose own first read was superseded by newer text for the file', () => {
  const a = openTab('wt-1')
  const b = openTab('wt-2')
  const panelA: PanelHandle = { contents: {}, set: () => {} }
  const panelB: PanelHandle = { contents: {}, set: () => {} }
  act(() =>
    root.render(
      <>
        <Panel initial={{ [a]: { content: 'old disk', isBinary: false } }} handle={panelA} />
        <Panel initial={{}} handle={panelB} tracksRead={(id) => id === b} />
      </>
    )
  )

  act(() => panelA.set(a, 'saved text'))

  expect(panelB.contents[b]?.content).toBe('saved text')
})

it("doesn't seed a tab another panel has no read for", () => {
  const a = openTab('wt-1')
  const b = openTab('wt-2')
  const panelA: PanelHandle = { contents: {}, set: () => {} }
  const panelB: PanelHandle = { contents: {}, set: () => {} }
  act(() =>
    root.render(
      <>
        <Panel initial={{ [a]: { content: 'old', isBinary: false } }} handle={panelA} />
        <Panel initial={{}} handle={panelB} tracksRead={() => false} />
      </>
    )
  )

  act(() => panelA.set(a, 'saved text'))

  expect(panelB.contents[b]).toBeUndefined()
})

it("a read started by a panel that has since closed still fills the other panel's tab", () => {
  const a = openTab('wt-1')
  const b = openTab('wt-2')
  const panelA: PanelHandle = { contents: {}, set: () => {} }
  const panelB: PanelHandle = { contents: {}, set: () => {} }
  act(() =>
    root.render(
      <>
        <Panel initial={{}} handle={panelA} tracksRead={(id) => id === a} />
        <Panel initial={{}} handle={panelB} tracksRead={(id) => id === b} />
      </>
    )
  )
  // B started the newest read, then its panel closed.
  act(() => root.render(<Panel initial={{}} handle={panelA} tracksRead={(id) => id === a} />))

  act(() => publishEditorBufferContent(b, { content: 'disk text', isBinary: false }))

  expect(panelA.contents[a]?.content).toBe('disk text')
})

it("doesn't copy one live log tail's bytes into another tail of the same file", () => {
  const a = openTab('wt-1')
  const b = openTab('wt-2')
  fixture.store?.setState({
    openFiles: (fixture.store?.getState().openFiles ?? []).map((file) => ({
      ...file,
      readOnly: true,
      liveTail: true
    }))
  })
  const panelB: PanelHandle = { contents: {}, set: () => {} }
  act(() =>
    root.render(<Panel initial={{ [b]: { content: 'tail b', isBinary: false } }} handle={panelB} />)
  )

  act(() => publishEditorBufferContent(a, { content: 'tail b plus new lines', isBinary: false }))

  expect(panelB.contents[b]?.content).toBe('tail b')
})

it("a failed newest read reaches a panel still showing older text, so it can't look current", () => {
  const a = openTab('wt-1')
  const b = openTab('wt-2')
  const panelB: PanelHandle = { contents: {}, set: () => {} }
  act(() =>
    root.render(
      <Panel initial={{ [b]: { content: 'old disk', isBinary: false } }} handle={panelB} />
    )
  )

  act(() =>
    publishEditorBufferContent(a, { content: '', isBinary: false, loadError: 'connection lost' })
  )

  expect(panelB.contents[b]?.loadError).toBe('connection lost')
})

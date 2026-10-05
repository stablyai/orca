// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { getDefaultSettings } from '../../../../shared/constants'

const probe = vi.hoisted(() => {
  const state: { markdownAnnotationsEnabled: boolean | null } = {
    markdownAnnotationsEnabled: null
  }
  return state
})

vi.mock('./EditorPanelShell', () => ({
  EditorPanelShell: (props: { markdownAnnotationsEnabled: boolean }) => {
    probe.markdownAnnotationsEnabled = props.markdownAnnotationsEnabled
    return null
  }
}))

vi.mock('./useEditorPanelContentState', () => ({
  useEditorPanelContentState: () => ({
    fileContents: { '/repo/notes.md': { content: '# Notes\n', isBinary: false } },
    diffContents: {},
    reloadContent: () => {}
  })
}))

import EditorPanel from './EditorPanel'

const file: OpenFile = {
  id: '/repo/notes.md',
  filePath: '/repo/notes.md',
  relativePath: 'notes.md',
  worktreeId: 'wt-1',
  language: 'markdown',
  mode: 'edit',
  isDirty: false
}

const initialAppState = useAppStore.getInitialState()
let container: HTMLDivElement
let root: Root

async function renderWithSetting(
  markdownReviewToolsEnabled: boolean,
  props: { markdownAnnotationsEnabled?: boolean } = {}
): Promise<void> {
  useAppStore.setState({
    settings: { ...getDefaultSettings('/tmp'), markdownReviewToolsEnabled }
  })
  await act(async () => root.render(<EditorPanel {...props} />))
}

describe('EditorPanel markdown review tools setting', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    probe.markdownAnnotationsEnabled = null
    useAppStore.setState(initialAppState, true)
    useAppStore.setState({
      openFiles: [file],
      activeFileId: file.id,
      markdownViewMode: { [file.id]: 'preview' },
      gitStatusByWorktree: { 'wt-1': [] }
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    document.body.replaceChildren()
    useAppStore.setState(initialAppState, true)
  })

  it('enables review tools when the setting is on', async () => {
    await renderWithSetting(true)
    expect(probe.markdownAnnotationsEnabled).toBe(true)
  })

  it('disables review tools when the setting is off', async () => {
    await renderWithSetting(false)
    expect(probe.markdownAnnotationsEnabled).toBe(false)
  })

  it('keeps a caller opt-out even when the setting is on', async () => {
    await renderWithSetting(true, { markdownAnnotationsEnabled: false })
    expect(probe.markdownAnnotationsEnabled).toBe(false)
  })
})

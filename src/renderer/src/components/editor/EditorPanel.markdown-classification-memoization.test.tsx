// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import type { FileContent } from './editor-panel-content-types'
import type * as MarkdownRichModeModule from './markdown-rich-mode'
import type * as MarkdownRoundTripModule from './markdown-round-trip'

type ShellProps = {
  onContentChangeForFile: (file: OpenFile | null, content: string) => void
}

const probe = vi.hoisted(() => ({
  eligibility: vi.fn(),
  roundTrip: vi.fn(),
  shellRender: vi.fn(),
  lastShellProps: null as ShellProps | null
}))

const contentState = vi.hoisted(() => ({
  fileContents: {} as Record<string, FileContent>
}))

vi.mock('./markdown-rich-mode', async (importActual) => {
  const actual = await importActual<typeof MarkdownRichModeModule>()
  return {
    ...actual,
    getMarkdownRichModeEligibility: (params: { content: string; sizeOverridden: boolean }) => {
      probe.eligibility(params.content)
      return actual.getMarkdownRichModeEligibility(params)
    }
  }
})

vi.mock('./markdown-round-trip', async (importActual) => {
  const actual = await importActual<typeof MarkdownRoundTripModule>()
  return {
    ...actual,
    getRichMarkdownRoundTripOutput: (content: string) => {
      probe.roundTrip(content)
      return actual.getRichMarkdownRoundTripOutput(content)
    }
  }
})

vi.mock('./EditorPanelShell', () => ({
  EditorPanelShell: (props: ShellProps) => {
    probe.shellRender()
    probe.lastShellProps = props
    return <div data-editor-panel-shell="true" />
  }
}))

vi.mock('./useEditorPanelContentState', () => ({
  useEditorPanelContentState: () => ({
    fileContents: contentState.fileContents,
    diffContents: {},
    reloadContent: () => {}
  })
}))

import EditorPanel from './EditorPanel'
import { resetMarkdownRichModeEligibilityCache } from './markdown-rich-mode-eligibility-cache'

const WORKTREE_ID = 'wt-memo'
const FILE_PATH = '/repo/notes.md'

// Why: HTML in the body is the branch that reaches the TipTap round trip, and
// staying under 50 KB keeps the round trip eligible rather than size-blocked.
const MARKDOWN_WITH_HTML = [
  '---',
  'title: Notes',
  '---',
  '',
  '# Notes',
  '',
  '<div class="callout">Heads up</div>',
  '',
  '<!-- a comment -->',
  '',
  'Body text.',
  ''
].join('\n')

function makeOpenFile(): OpenFile {
  return {
    id: FILE_PATH,
    filePath: FILE_PATH,
    relativePath: 'notes.md',
    worktreeId: WORKTREE_ID,
    language: 'markdown',
    mode: 'edit',
    isDirty: false
  }
}

const initialAppState = useAppStore.getInitialState()
let container: HTMLDivElement
let root: Root

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('EditorPanel markdown classification memoization', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    probe.eligibility.mockClear()
    probe.roundTrip.mockClear()
    probe.shellRender.mockClear()
    probe.lastShellProps = null
    resetMarkdownRichModeEligibilityCache()
    const file = makeOpenFile()
    contentState.fileContents = { [file.id]: { content: MARKDOWN_WITH_HTML, isBinary: false } }
    useAppStore.setState(initialAppState, true)
    useAppStore.setState({
      openFiles: [file],
      activeFileId: file.id,
      markdownViewMode: { [file.id]: 'rich' },
      gitStatusByWorktree: { [WORKTREE_ID]: [] }
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    document.body.replaceChildren()
    useAppStore.setState(initialAppState, true)
    resetMarkdownRichModeEligibilityCache()
  })

  it('classifies once per content change, not once per unrelated store write', async () => {
    await act(async () => root.render(<EditorPanel />))
    await flushEffects()

    expect(container.querySelector('[data-editor-panel-shell="true"]')).not.toBeNull()
    expect(probe.eligibility).toHaveBeenCalledTimes(1)
    expect(probe.roundTrip).toHaveBeenCalledTimes(1)

    const rendersAfterMount = probe.shellRender.mock.calls.length

    // An idle git-status poll: same data, fresh array identity, exactly what the
    // worktree poller writes on every tick.
    for (let tick = 0; tick < 20; tick += 1) {
      await act(async () => {
        useAppStore.setState({ gitStatusByWorktree: { [WORKTREE_ID]: [] } })
      })
    }

    expect(probe.shellRender.mock.calls.length).toBeGreaterThan(rendersAfterMount)
    expect(probe.eligibility).toHaveBeenCalledTimes(1)
    expect(probe.roundTrip).toHaveBeenCalledTimes(1)
  })

  it('reclassifies when the document content actually changes', async () => {
    await act(async () => root.render(<EditorPanel />))
    await flushEffects()
    expect(probe.eligibility).toHaveBeenCalledTimes(1)

    await act(async () => {
      useAppStore.getState().setEditorDraft(FILE_PATH, `${MARKDOWN_WITH_HTML}\nMore text.\n`)
    })

    expect(probe.eligibility).toHaveBeenCalledTimes(2)
    expect(probe.eligibility).toHaveBeenLastCalledWith(`${MARKDOWN_WITH_HTML}\nMore text.\n`)
  })

  it('flips the dirty flag on edit and back on undo to the original', async () => {
    await act(async () => root.render(<EditorPanel />))
    await flushEffects()

    const file = useAppStore.getState().openFiles[0]
    const change = (content: string): Promise<void> =>
      act(async () => probe.lastShellProps?.onContentChangeForFile(file, content))
    const isDirty = (): boolean | undefined =>
      useAppStore.getState().openFiles.find((entry) => entry.id === FILE_PATH)?.isDirty

    expect(isDirty()).toBe(false)

    await change(`${MARKDOWN_WITH_HTML}a`)
    expect(isDirty()).toBe(true)

    await change(`${MARKDOWN_WITH_HTML}ab`)
    expect(isDirty()).toBe(true)

    await change(`${MARKDOWN_WITH_HTML}a`)
    expect(isDirty()).toBe(true)

    // Undo back to the loaded content.
    await change(MARKDOWN_WITH_HTML)
    expect(isDirty()).toBe(false)

    // Markdown ignores trailing whitespace, exactly as before.
    await change(`${MARKDOWN_WITH_HTML}\n\n`)
    expect(isDirty()).toBe(false)

    // A same-length edit is still detected.
    await change(`${MARKDOWN_WITH_HTML.slice(0, -1)}X`)
    expect(isDirty()).toBe(true)

    await change(MARKDOWN_WITH_HTML)
    expect(isDirty()).toBe(false)
  })

  it('keeps the content-change callback identity stable across content loads', async () => {
    await act(async () => root.render(<EditorPanel />))
    await flushEffects()

    const initialCallback = probe.lastShellProps?.onContentChangeForFile
    expect(initialCallback).toBeTypeOf('function')

    // A background file read replaces the loaded-content maps.
    contentState.fileContents = {
      [FILE_PATH]: { content: `${MARKDOWN_WITH_HTML}\nReloaded.\n`, isBinary: false }
    }
    await act(async () => {
      useAppStore.setState({ gitStatusByWorktree: { [WORKTREE_ID]: [] } })
    })

    expect(probe.lastShellProps?.onContentChangeForFile).toBe(initialCallback)

    // …and the stable callback still compares against the freshly loaded content.
    const file = useAppStore.getState().openFiles[0]
    await act(async () =>
      probe.lastShellProps?.onContentChangeForFile(file, `${MARKDOWN_WITH_HTML}\nReloaded.\n`)
    )
    expect(useAppStore.getState().openFiles[0]?.isDirty).toBe(false)
  })
})

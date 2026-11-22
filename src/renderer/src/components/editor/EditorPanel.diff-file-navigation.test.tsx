// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import type { GitStatusEntry } from '../../../../shared/git/status/git-status-types'
import type { WorktreeDiffNavigationDirection } from './diff/review/worktree-diff-file-navigation'

type ProviderProps = {
  children: React.ReactNode
  canNavigateFile?: boolean
  onNavigateFile?: (direction: WorktreeDiffNavigationDirection) => boolean
  arrivalReveal?: WorktreeDiffNavigationDirection | null
}

type PanelShellProbeProps = {
  model: { isDiffSurface: boolean; isChangesMode: boolean; hasWorktreeDiffNavigation: boolean }
}

type PanelProbe = {
  providerProps: ProviderProps | null
  shellProps: PanelShellProbeProps | null
  contentState: {
    fileContents: Record<string, unknown>
    diffContents: Record<string, unknown>
    reloadContent: () => void
  }
}

const panelProbe = vi.hoisted((): PanelProbe => ({
  providerProps: null,
  shellProps: null,
  contentState: {
    fileContents: {},
    diffContents: {},
    reloadContent: () => {}
  }
}))

vi.mock('./diff/review/diff-navigation-context', () => ({
  DiffNavigationProvider: (props: ProviderProps) => {
    panelProbe.providerProps = props
    return <div data-diff-navigation-provider>{props.children}</div>
  }
}))

vi.mock('./panel/EditorPanelShell', () => ({
  EditorPanelShell: (props: {
    model: { isDiffSurface: boolean; isChangesMode: boolean; hasWorktreeDiffNavigation: boolean }
  }) => {
    panelProbe.shellProps = props
    return <div data-editor-panel-shell />
  }
}))

vi.mock('./loading/useEditorPanelContentState', () => ({
  useEditorPanelContentState: () => panelProbe.contentState
}))

import EditorPanel from './EditorPanel'

const WORKTREE_ID = 'wt-1'
const WORKTREE_ROOT = '/repo'
const GROUP_ID = 'group-1'
const initialAppState = useAppStore.getInitialState()
let container: HTMLDivElement
let root: Root

const unstaged = (path: string): GitStatusEntry => ({ path, status: 'modified', area: 'unstaged' })
const untracked = (path: string): GitStatusEntry => ({
  path,
  status: 'untracked',
  area: 'untracked'
})
const deleted = (path: string): GitStatusEntry => ({ path, status: 'deleted', area: 'unstaged' })

function makeOpenFile(relativePath = 'src/a.ts', overrides: Partial<OpenFile> = {}): OpenFile {
  const filePath = `${WORKTREE_ROOT}/${relativePath}`
  return {
    id: filePath,
    filePath,
    relativePath,
    worktreeId: WORKTREE_ID,
    language: 'typescript',
    mode: 'edit',
    isDirty: false,
    ...overrides
  }
}

function seedState(
  activeFile: OpenFile,
  entries: GitStatusEntry[],
  extra: Partial<ReturnType<typeof useAppStore.getState>> = {}
): void {
  const { openFiles: extraOpenFiles, editorViewMode: extraEditorViewMode, ...restExtra } = extra
  const editorViewMode = { [activeFile.id]: 'changes', ...extraEditorViewMode }
  useAppStore.setState(initialAppState, true)
  const patch = {
    openFiles: extraOpenFiles ? [activeFile, ...extraOpenFiles] : [activeFile],
    activeFileId: activeFile.id,
    activeFileIdByWorktree: { [WORKTREE_ID]: activeFile.id },
    activeWorktreeId: WORKTREE_ID,
    activeTabType: 'editor',
    activeTabTypeByWorktree: { [WORKTREE_ID]: 'editor' },
    editorViewMode,
    gitStatusByWorktree: { [WORKTREE_ID]: entries },
    groupsByWorktree: {
      [WORKTREE_ID]: [{ id: GROUP_ID, worktreeId: WORKTREE_ID, activeTabId: null, tabOrder: [] }]
    },
    activeGroupIdByWorktree: { [WORKTREE_ID]: GROUP_ID },
    worktreesByRepo: {
      repo: [
        {
          id: WORKTREE_ID,
          repoId: 'repo',
          path: WORKTREE_ROOT,
          displayName: 'repo'
        }
      ]
    },
    ...restExtra
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: seeded worktree rows carry only the fields the navigation reads.
  useAppStore.setState(patch as Partial<ReturnType<typeof useAppStore.getState>>)
}

async function renderPanel(): Promise<void> {
  await act(async () => root.render(<EditorPanel />))
}

async function navigateFile(direction: WorktreeDiffNavigationDirection): Promise<boolean> {
  let result = false
  await act(async () => {
    result = panelProbe.providerProps?.onNavigateFile?.(direction) ?? false
  })
  return result
}

describe('EditorPanel worktree diff file navigation', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    panelProbe.providerProps = null
    panelProbe.shellProps = null
    panelProbe.contentState = { fileContents: {}, diffContents: {}, reloadContent: () => {} }
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    document.body.replaceChildren()
    useAppStore.setState(initialAppState, true)
    panelProbe.providerProps = null
    panelProbe.shellProps = null
  })

  it('opens an unopened unstaged candidate in Changes mode in the active group', async () => {
    const activeFile = makeOpenFile('src/a.ts')
    seedState(activeFile, [unstaged('src/a.ts'), unstaged('src/b.ts')])
    await renderPanel()

    expect(await navigateFile('next')).toBe(true)
    const opened = useAppStore.getState().openFiles.find((file) => file.relativePath === 'src/b.ts')
    expect(opened).toEqual(
      expect.objectContaining({
        id: '/repo/src/b.ts',
        filePath: '/repo/src/b.ts',
        relativePath: 'src/b.ts',
        worktreeId: WORKTREE_ID,
        language: 'typescript',
        mode: 'edit'
      })
    )
    expect(useAppStore.getState().editorViewMode['/repo/src/b.ts']).toBe('changes')
    expect(useAppStore.getState().activeGroupIdByWorktree[WORKTREE_ID]).toBe(GROUP_ID)
  })

  it('reuses an existing edit tab and selects Changes mode', async () => {
    const activeFile = makeOpenFile('src/a.ts')
    const existing = makeOpenFile('src/b.ts')
    seedState(activeFile, [unstaged('src/a.ts'), unstaged('src/b.ts')], {
      openFiles: [existing],
      editorViewMode: { [activeFile.id]: 'changes', [existing.id]: 'edit' }
    })
    await renderPanel()

    expect(await navigateFile('next')).toBe(true)

    const state = useAppStore.getState()
    expect(state.openFiles.filter((file) => file.relativePath === 'src/b.ts')).toHaveLength(1)
    expect(state.activeFileId).toBe(existing.id)
    expect(state.editorViewMode[existing.id]).toBe('changes')
  })

  it('skips staged-only paths', async () => {
    const activeFile = makeOpenFile('src/a.ts')
    seedState(activeFile, [
      unstaged('src/a.ts'),
      { path: 'src/staged-only.ts', status: 'modified', area: 'staged' },
      unstaged('src/z.ts')
    ])
    await renderPanel()

    expect(await navigateFile('next')).toBe(true)

    expect(useAppStore.getState().activeFileId).toBe('/repo/src/z.ts')
  })

  it('opens an untracked target in Changes mode', async () => {
    const activeFile = makeOpenFile('src/a.ts')
    seedState(activeFile, [unstaged('src/a.ts'), untracked('src/new.ts')])
    await renderPanel()

    expect(await navigateFile('next')).toBe(true)

    expect(
      useAppStore.getState().openFiles.find((file) => file.relativePath === 'src/new.ts')
    ).toEqual(expect.objectContaining({ mode: 'edit', language: 'typescript' }))
    expect(useAppStore.getState().editorViewMode['/repo/src/new.ts']).toBe('changes')
  })

  it('opens deleted unstaged targets as unstaged single-file diffs', async () => {
    const activeFile = makeOpenFile('src/a.ts')
    seedState(activeFile, [unstaged('src/a.ts'), deleted('src/deleted.ts')])
    await renderPanel()

    expect(await navigateFile('next')).toBe(true)

    expect(useAppStore.getState().activeFileId).toBe(
      `${WORKTREE_ID}::diff::unstaged::src/deleted.ts`
    )
    expect(
      useAppStore.getState().openFiles.find((file) => file.relativePath === 'src/deleted.ts')
    ).toEqual(expect.objectContaining({ mode: 'diff', diffSource: 'unstaged' }))
  })

  it('returns false when there is no second candidate', async () => {
    const activeFile = makeOpenFile('src/a.ts')
    seedState(activeFile, [unstaged('src/a.ts')])
    await renderPanel()

    expect(panelProbe.providerProps?.canNavigateFile).toBe(false)
    expect(await navigateFile('next')).toBe(false)
  })

  it('uses the resolver insertion fallback when an unstaged diff path disappeared', async () => {
    const activeFile = makeOpenFile('src/b.ts', {
      id: `${WORKTREE_ID}::diff::unstaged::src/b.ts`,
      mode: 'diff',
      diffSource: 'unstaged'
    })
    seedState(activeFile, [unstaged('src/a.ts'), unstaged('src/c.ts'), unstaged('src/d.ts')])
    await renderPanel()

    expect(await navigateFile('next')).toBe(true)

    expect(useAppStore.getState().activeFileId).toBe('/repo/src/c.ts')
  })

  it('does not enable file-boundary navigation for staged-only Changes-mode edit tabs', async () => {
    const activeFile = makeOpenFile('src/staged-only.ts')
    seedState(activeFile, [
      { path: 'src/staged-only.ts', status: 'modified', area: 'staged' },
      unstaged('src/z.ts')
    ])
    await renderPanel()

    expect(panelProbe.providerProps?.canNavigateFile).toBe(false)
    expect(panelProbe.providerProps?.onNavigateFile).toBeUndefined()
  })

  it('keeps file-boundary controls available for binary eligible Changes-mode edit tabs', async () => {
    const activeFile = makeOpenFile('src/image.bin', { language: 'plaintext' })
    panelProbe.contentState = {
      fileContents: { [activeFile.id]: { content: '', isBinary: true } },
      diffContents: {},
      reloadContent: () => {}
    }
    seedState(activeFile, [unstaged('src/image.bin'), unstaged('src/next.ts')])
    await renderPanel()

    // Binary Changes tabs render no diff surface, so the toggle must stay hidden while the sweep stays enabled.
    expect(panelProbe.providerProps?.canNavigateFile).toBe(true)
    expect(panelProbe.shellProps?.model.isDiffSurface).toBe(false)
    expect(panelProbe.shellProps?.model.isChangesMode).toBe(false)
    expect(panelProbe.shellProps?.model.hasWorktreeDiffNavigation).toBe(true)

    expect(await navigateFile('next')).toBe(true)
    expect(useAppStore.getState().activeFileId).toBe('/repo/src/next.ts')
  })

  it('does not enable file-boundary navigation for staged diff tabs', async () => {
    const activeFile = makeOpenFile('src/a.ts', {
      id: `${WORKTREE_ID}::diff::staged::src/a.ts`,
      mode: 'diff',
      diffSource: 'staged'
    })
    seedState(activeFile, [unstaged('src/a.ts'), unstaged('src/b.ts')])
    await renderPanel()

    expect(panelProbe.providerProps?.canNavigateFile).toBe(false)
    expect(panelProbe.providerProps?.onNavigateFile).toBeUndefined()
  })

  it('arms the arrival reveal for the hop target and disarms it once the pane moves on', async () => {
    const activeFile = makeOpenFile('src/a.ts')
    seedState(activeFile, [unstaged('src/a.ts'), unstaged('src/b.ts')])
    await renderPanel()
    expect(panelProbe.providerProps?.arrivalReveal).toBeNull()

    expect(await navigateFile('next')).toBe(true)
    expect(panelProbe.providerProps?.arrivalReveal).toBe('next')

    await act(async () => {
      useAppStore.setState({ activeFileId: '/repo/src/a.ts' })
    })
    expect(panelProbe.providerProps?.arrivalReveal).toBeNull()
  })
})

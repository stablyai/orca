import { getDefaultSettings } from '../../../../../../shared/orca-profiles/constants'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { makeRepo, makeWorktree } from '../../../worktree-jump/worktree-jump-palette-test-fixtures'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import {
  __resetLocalWatchPauseStoreForTests,
  applyLocalWatchPausedPayload,
  noteLocalWatchRootHeld
} from '../../external-changes/reload-from-disk/editor-watch-pause-store'
import {
  resetEditorReloadInFlight,
  runEditorReloadExclusive
} from '../../external-changes/reload-from-disk/editor-reload-in-flight'
import { ExternalFileChangeBanner } from '../../external-changes/ExternalFileChangeBanner'
import { EditorPanelHeader } from './EditorPanelHeader'

const ROOT = '/Users/you/projects/gtm'
const repo = { ...makeRepo(), path: ROOT, displayName: 'gtm' }
const worktree = makeWorktree('wt-gtm', 'gtm', { path: ROOT, isMainWorktree: true })

const file: OpenFile = {
  id: `${ROOT}/copy/launch-copy-v3.md`,
  filePath: `${ROOT}/copy/launch-copy-v3.md`,
  relativePath: 'copy/launch-copy-v3.md',
  worktreeId: worktree.id,
  language: 'markdown',
  isDirty: false,
  mode: 'edit'
}

const store = {
  settings: getDefaultSettings('/home/fixture'),
  repos: [repo],
  worktreesByRepo: { [repo.id]: [worktree] },
  activeWorktreeId: worktree.id,
  openFiles: [file],
  activeFileId: file.id
}

function Header({ dirty = false }: { dirty?: boolean }): React.JSX.Element {
  const shown = dirty ? { ...file, isDirty: true } : file
  return (
    <div className="bg-editor-surface">
      <EditorPanelHeader
        activeFile={shown}
        viewStateId={shown.id}
        copiedPathVisible={false}
        isSingleDiff={false}
        isDiffSurface={false}
        isMarkdown
        isCsv={false}
        isNotebook={false}
        hasEditorToggle
        availableEditorToggleModes={['source', 'rich', 'changes']}
        effectiveToggleValue="rich"
        canOpenPreview={false}
        canShowMarkdownPreview
        canShowMarkdownTableOfContents
        isMarkdownTableOfContentsDisabled={false}
        shouldShowMarkdownExportAction
        canExportMarkdownToPdf
        showMarkdownTableOfContents={false}
        canShowMarkdownFrontmatterToggle={false}
        markdownFrontmatterVisible={false}
        sideBySide={false}
        openFileState={{ canOpen: true }}
        onCopyPath={() => {}}
        onOpenDiffTargetFile={() => {}}
        onOpenPreview={() => {}}
        onOpenMarkdownPreview={() => {}}
        onToggleSideBySide={() => {}}
        onEditorToggleChange={() => {}}
        onToggleMarkdownTableOfContents={() => {}}
        onToggleMarkdownFrontmatter={() => {}}
        onExportMarkdownToPdf={() => {}}
        onReloadFromDisk={() => {}}
      />
      {dirty ? (
        <ExternalFileChangeBanner
          file={{ ...shown, externalMutation: 'changed' }}
          currentContent="draft"
          reloadContent={() => {}}
        />
      ) : null}
    </div>
  )
}

/** Fixtures share one page; each starts with no reload running and no paused roots. */
function resetReloadState(): void {
  resetEditorReloadInFlight()
  __resetLocalWatchPauseStoreForTests()
}

function reloadButton(frame: HTMLElement): HTMLElement | null {
  return frame.querySelector<HTMLElement>('button[aria-label^="Reload from Disk"]')
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** The always-on reload icon, left of the view-mode toggle, as in the common in-sync case. */
export const inSync = defineFixture({
  width: 900,
  store,
  setup: resetReloadState,
  render: () => <Header />
})

/** Hover tooltip while main reports the folder's watcher paused. */
export const pausedTooltip = defineFixture({
  width: 900,
  store,
  setup: () => {
    resetReloadState()
    noteLocalWatchRootHeld(ROOT)
    applyLocalWatchPausedPayload({ worktreePath: ROOT, paused: true })
  },
  render: () => (
    <div className="pb-10">
      <Header />
    </div>
  ),
  interact: async (frame) => {
    const button = reloadButton(frame)
    button?.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' }))
    button?.focus()
    await wait(1500)
  }
})

/** A slow (e.g. SSH) read: the spinner appears after 200 ms. */
export const reloading = defineFixture({
  width: 900,
  store,
  setup: () => {
    resetReloadState()
    void runEditorReloadExclusive(file.id, () => new Promise(() => {}), { showSpinner: true })
  },
  render: () => <Header />,
  interact: async () => {
    await wait(350)
  }
})

/** Narrow split: the path truncates and every Markdown icon keeps its place. */
export const narrowPane = defineFixture({
  width: 440,
  store,
  setup: resetReloadState,
  render: () => <Header />
})

/** "…" menu: Reload from Disk in its own group after the file-location items. */
export const menu = defineFixture({
  width: 900,
  store,
  setup: resetReloadState,
  render: () => (
    <div className="pb-72">
      <Header />
    </div>
  ),
  interact: async (frame) => {
    const trigger = frame.querySelector<HTMLElement>('[data-editor-actions-trigger]')
    trigger?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    await wait(300)
  }
})

/** Unsaved edits + a different disk: the click raises the existing amber banner. */
export const conflict = defineFixture({
  width: 900,
  setup: resetReloadState,
  store: { ...store, openFiles: [{ ...file, isDirty: true, externalMutation: 'changed' }] },
  render: () => <Header dirty />
})

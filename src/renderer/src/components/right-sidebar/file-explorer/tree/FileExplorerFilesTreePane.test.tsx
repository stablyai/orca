// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { isFocusKeepingPress } from '@/lib/overlay-interaction/focus-keeping-press'
import {
  releaseTerminalFocusForOutsidePointerDown,
  type TerminalInputFocusSync
} from '@/components/terminal-pane/input/focus/regular-terminal-focus-ownership'
import { FileExplorerFilesTreePane, isFilesTreeBackgroundPress } from './FileExplorerFilesTreePane'

afterEach(cleanup)

/** The terminal host, with its helper textarea focused as it is after a click in a pane. */
function renderFocusedTerminal(): {
  container: HTMLDivElement
  helper: HTMLTextAreaElement
  syncFocused: TerminalInputFocusSync
  focused: string[]
} {
  const container = document.createElement('div')
  container.setAttribute('data-terminal-workbench-container', '')
  const helper = document.createElement('textarea')
  helper.className = 'xterm-helper-textarea'
  container.appendChild(helper)
  document.body.appendChild(container)
  helper.focus()
  const focused: string[] = []
  const syncFocused: TerminalInputFocusSync = (isFocused) => {
    focused.push(String(isFocused))
  }
  return { container, helper, syncFocused, focused }
}

/** An empty tree: no rows render, so only the ScrollArea viewport and its handlers are exercised. */
function renderTree(onDoubleClick = (): void => {}): void {
  render(
    <FileExplorerFilesTreePane
      activeRepo={null}
      worktreePath="/repo"
      displayRootPath="/repo"
      explorerView="files"
      activeFileId={null}
      hasNameFilter={false}
      nameFilterSource={null}
      nameFilterFiles={{ relativePaths: [], loadError: null } as never}
      handleExpandNameFilterDir={() => {}}
      tree={{ loadingDirPaths: new Set<string>(), rootError: null, dirCache: {} } as never}
      selection={{ selectedPaths: new Set<string>() } as never}
      paneState={
        {
          scrollRef: { current: null },
          fileDropOwnerRef: { current: null },
          runtimeDownloadContext: null,
          canOpenWorkspaceFileBrowserForPath: () => false,
          statusByRelativePath: new Map(),
          folderStatusByRelativePath: new Map(),
          deletion: { deleteShortcutLabel: '' },
          dragDrop: {
            dropTargetDir: null,
            setDropTargetDir: () => {},
            dragSourcePath: null,
            setDragSourcePath: () => {},
            isRootDragOver: false,
            isNativeDragOver: false,
            nativeDropTargetDir: null,
            setNativeDropTargetDir: () => {},
            handleMoveDrop: () => {},
            handleDragExpandDir: () => {},
            handleNativeDragExpandDir: () => {},
            stopDragEdgeScroll: () => {},
            rootDragHandlers: {}
          },
          nodeCommands: {},
          handlers: {
            handleClick: () => {},
            handleDoubleClick: () => {},
            handleWheelCapture: () => {}
          },
          rowScrolling: { virtualizer: {}, flashingPath: null },
          inlineInputState: {
            inlineInput: null,
            inlineInputIndex: -1,
            startNew: () => {},
            dismissInlineInput: () => {},
            handleInlineSubmit: () => {}
          }
        } as never
      }
      rowProjection={{} as never}
      ignoredByRelativePath={new Set<string>()}
      rowExpandedPaths={new Set<string>()}
      visibleRowCount={0}
      handleExplorerBackgroundContextMenuCapture={() => {}}
      handleExplorerBackgroundDoubleClick={onDoubleClick}
    />
  )
}

it('the outside-press release keeps the terminal when the press lands on the tree background', () => {
  const { container, helper, syncFocused, focused } = renderFocusedTerminal()
  renderTree()
  const background = document.querySelector(
    '[data-slot="scroll-area-viewport"]'
  ) as HTMLElement as HTMLElement

  const released = releaseTerminalFocusForOutsidePointerDown({
    container,
    activeElement: helper,
    pointerTarget: background,
    syncFocused
  })

  expect(released).toBe(false)
  expect(focused).toEqual([])
  expect(document.activeElement).toBe(helper)
})

it('the rendered viewport carries the marker and is recognised as the background', () => {
  renderFocusedTerminal()
  renderTree()
  const viewport = document.querySelector('[data-slot="scroll-area-viewport"]') as HTMLElement

  expect(viewport.hasAttribute('data-keeps-focus')).toBe(true)
  expect(isFocusKeepingPress(viewport)).toBe(true)
  expect(isFilesTreeBackgroundPress(viewport)).toBe(true)
})

it('the viewport background still opens a new file on double click', () => {
  let doubleClicks = 0
  renderFocusedTerminal()
  renderTree(() => {
    doubleClicks += 1
  })

  const viewport = document.querySelector('[data-slot="scroll-area-viewport"]') as HTMLElement
  viewport.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))

  expect(doubleClicks).toBe(1)
})

it('nothing is kept when focus was not in a pane to begin with', () => {
  renderTree()
  const viewport = document.querySelector('[data-slot="scroll-area-viewport"]') as HTMLElement
  const outside = document.createElement('input')
  document.body.appendChild(outside)
  outside.focus()

  expect(isFilesTreeBackgroundPress(viewport)).toBe(false)
  expect(isFilesTreeBackgroundPress(null)).toBe(false)
})

it('a control inside the pane keeps its own press and its own focus', () => {
  renderFocusedTerminal()
  renderTree()
  const viewport = document.querySelector('[data-slot="scroll-area-viewport"]') as HTMLElement
  // The root-error Retry button: pressing it must not read as a background press, so its
  // mouse-down focus behaviour is left alone.
  const retry = document.createElement('button')
  viewport.appendChild(retry)

  expect(isFilesTreeBackgroundPress(retry)).toBe(false)
  expect(isFilesTreeBackgroundPress(viewport)).toBe(true)
})

// @vitest-environment happy-dom
import type { ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { FileExplorerFilesTreePane } from './FileExplorerFilesTreePane'
import { FileExplorerTreeStatus } from './FileExplorerTreeStatus'
import { visit, type ReactElementLike } from './file-explorer-element-tree-test-harness'

type Props = ComponentProps<typeof FileExplorerFilesTreePane>
function emptyPane(error?: string) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This element-tree fixture supplies every field read by the empty pane; child components and event handlers are not executed.
  return FileExplorerFilesTreePane({
    worktreePath: '/repo',
    displayRootPath: '/repo/src',
    explorerView: 'files',
    visibleRowCount: 0,
    hasNameFilter: false,
    tree: {
      loadingDirPaths: new Set(),
      rootError: 'Full root unavailable',
      dirCache: { '/repo/src': { children: [], error } }
    },
    selection: {},
    paneState: {
      inlineInputState: {},
      rowScrolling: {},
      handlers: {},
      nodeCommands: {},
      dragDrop: { rootDragHandlers: {} }
    }
  } as unknown as Props)
}

it.each([undefined, 'Permission denied', ''])(
  'uses the selected root error (%j), not a stale full-root error',
  (error) => {
    const elements: ReactElementLike[] = []
    visit(emptyPane(error), (element) => elements.push(element))
    const status = elements.find((element) => element.type === FileExplorerTreeStatus)
    expect(status?.props).toMatchObject({
      isLoading: false,
      error: error ?? null,
      isEmpty: error === undefined
    })
    expect(elements.some((element) => element.props?.role === 'status')).toBe(error !== undefined)
  }
)

it('renders an empty error message as a failed read rather than an empty directory', () => {
  const markup = renderToStaticMarkup(<FileExplorerTreeStatus isLoading={false} error="" isEmpty />)
  expect(markup).toContain('Could not load files for this workspace:')
  expect(markup).not.toContain('No files in this workspace')
})

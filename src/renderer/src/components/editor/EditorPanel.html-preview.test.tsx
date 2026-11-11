// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  EDITOR_OWNER,
  EDITOR_PLACEMENT,
  seedEditorPlacementConsumers
} from '@/store/slices/editor/tabs/editor-placement-consumers.test-fixture'

vi.mock('./useEditorPanelContentState', () => ({
  useEditorPanelContentState: () => ({
    fileContents: {},
    diffContents: {},
    reloadContent: () => {}
  })
}))
vi.mock('./EditorContent', () => ({ EditorContent: () => null }))
vi.mock('@/components/browser-pane/host-guest/browser-focus', () => ({
  requestBrowserFocus: vi.fn()
}))

import EditorPanel from './EditorPanel'

afterEach(() => {
  cleanup()
  useAppStore.setState(useAppStore.getInitialState(), true)
})

it('opens the HTML preview in the clicked editor’s folder group', async () => {
  const file = seedEditorPlacementConsumers({
    mode: 'edit',
    filePath: '/repo/report.html',
    relativePath: 'report.html',
    language: 'html'
  })
  const screen = render(
    <TooltipProvider>
      <EditorPanel activeFileId={file.id} activeViewStateId="x-source-tab" />
    </TooltipProvider>
  )
  fireEvent.click(screen.getByRole('button', { name: 'Preview' }))

  await waitFor(() => {
    const state = useAppStore.getState()
    const browser = state.unifiedTabsByWorktree[EDITOR_PLACEMENT]?.find(
      (tab) => tab.contentType === 'browser'
    )
    expect(browser).toMatchObject({ groupId: 'x-source' })
    expect(state.browserPagesByWorkspace[browser!.entityId]?.[0]?.url).toBe(
      'file:///repo/report.html'
    )
    expect(state.activeBrowserTabId).toBe(browser!.entityId)
    expect(state.browserTabsByWorktree[EDITOR_OWNER] ?? []).toEqual([])
  })
})

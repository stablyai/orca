// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { seedEditorPlacementConsumers } from '@/store/slices/editor/tabs/editor-placement-consumers.test-fixture'

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (original) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await original())
)
vi.mock('@/runtime/workspace-layout/frames/runtime-layout-client', async (original) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await original())
)
vi.mock('./useEditorPanelContentState', () => ({
  useEditorPanelContentState: () => ({
    fileContents: {},
    diffContents: {},
    reloadContent: () => {}
  })
}))
vi.mock('./EditorPanelShell', () => ({
  EditorPanelShell: ({
    sideBySide,
    onToggleSideBySide
  }: {
    sideBySide: boolean
    onToggleSideBySide: () => void
  }) => <button onClick={onToggleSideBySide}>{sideBySide ? 'side-by-side' : 'inline'}</button>
}))

import EditorPanel from './EditorPanel'

afterEach(cleanup)

it('keeps the side-by-side toggle when the diff panel remounts', async () => {
  const file = seedEditorPlacementConsumers()
  useAppStore.setState({
    updateSettings: async (updates) =>
      useAppStore.setState((s) => ({ settings: s.settings && { ...s.settings, ...updates } }))
  })
  const first = render(<EditorPanel activeFileId={file.id} activeViewStateId="x-source-tab" />)
  await act(async () => fireEvent.click(first.getByText('inline')))
  expect(first.getByRole('button').textContent).toBe('side-by-side')
  first.unmount()
  const second = render(<EditorPanel activeFileId={file.id} activeViewStateId="x-source-tab" />)
  expect(second.getByRole('button').textContent).toBe('side-by-side')
})

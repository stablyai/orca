// @vitest-environment happy-dom
import { Activity } from 'react'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ORCA_EDITOR_FILE_SAVED_EVENT } from '@/components/editor/autosave/editor-autosave'
import { NativeChatPaneLifetime } from '../../pane/ownership/native-chat-pane-lifetime'
import { useNativeChatVisualDocument } from './use-native-chat-visual-document'

const read = vi.hoisted(() =>
  vi.fn(async (identity: { file: string }) => ({
    ok: true,
    document: { path: identity.file, revision: 'one', html: '<p>Visual</p>' }
  }))
)
vi.mock('./native-chat-visual-read-client', () => ({
  readNativeChatVisual: read,
  peekCachedNativeChatVisual: () => undefined,
  isRetryableNativeChatVisualFailure: () => false
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({ openFiles: [] }) } }))
vi.mock('@/components/editor/save/commands/editor-saved-event-view', () => ({
  editorSavedEventView: () => ({ filePath: '/visual-0.html', worktreeId: 'workspace' })
}))
vi.mock('@/lib/files/access/file-owner-runtime-target', () => ({
  getRuntimeTargetForFileOwner: () => ({ kind: 'local' })
}))

beforeEach(() => {
  read.mockClear()
})
afterEach(cleanup)

function Visual({ index }: { index: number }) {
  const state = useNativeChatVisualDocument(
    {
      target: { kind: 'local' },
      sessionId: 'session',
      file: `/visual-${index}.html`
    },
    true
  )
  return <span>{state.status}</span>
}

it.each([8, 80])(
  'retains %i unchanged visuals across returns, and revalidates a saved visual',
  async (count) => {
    const pane = (visible: boolean) => (
      <NativeChatPaneLifetime isVisible={visible}>
        <Activity mode={visible ? 'visible' : 'hidden'}>
          {Array.from({ length: count }, (_, index) => (
            <Visual key={index} index={index} />
          ))}
        </Activity>
      </NativeChatPaneLifetime>
    )
    const view = render(pane(true))
    await waitFor(() => expect(view.getAllByText('ready')).toHaveLength(count))
    expect(read).toHaveBeenCalledTimes(count)
    for (let visit = 0; visit < 3; visit++) {
      view.rerender(pane(false))
      await act(async () => {})
      view.rerender(pane(true))
      await act(async () => {})
    }
    expect(read).toHaveBeenCalledTimes(count)
    act(() => window.dispatchEvent(new Event(ORCA_EDITOR_FILE_SAVED_EVENT)))
    await waitFor(() => expect(read).toHaveBeenCalledTimes(count + 1))
    expect(read.mock.calls.at(-1)).toEqual([
      expect.objectContaining({ file: '/visual-0.html' }),
      { fresh: true }
    ])
    view.unmount()
    await act(async () => {})
  }
)

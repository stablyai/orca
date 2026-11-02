// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type * as ConnectionOwnerModule from '@/lib/connection-owner-resolution'
import type * as WorktreeRuntimeOwnerModule from '@/lib/worktree-runtime-owner'

const callRuntimeRpc = vi.fn()
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: (...args: unknown[]) => callRuntimeRpc(...args)
}))
vi.mock('./NativeChatTranscriptChrome', () => ({
  observeTranscriptVisibility: (_element: Element, onChange: (visible: boolean) => void) => {
    onChange(true)
    return () => {}
  }
}))
// A workspace on the paired host env-1.
vi.mock('@/lib/connection-owner-resolution', async (importOriginal) => ({
  ...(await importOriginal<typeof ConnectionOwnerModule>()),
  getConnectionIdForFileFromState: () => null
}))
vi.mock('@/lib/worktree-runtime-owner', async (importOriginal) => ({
  ...(await importOriginal<typeof WorktreeRuntimeOwnerModule>()),
  getRuntimeEnvironmentIdForWorktree: () => 'env-1'
}))

import { NativeChatInlineVisual } from './NativeChatInlineVisual'
import { readNativeChatVisual } from './native-chat-visual-read-client'
import { TooltipProvider } from '@/components/ui/tooltip'
import { openDocPreviewSource } from '@/components/browser-pane/workspace-doc/doc-preview-document-actions'
import { ORCA_EDITOR_FILE_SAVED_EVENT } from '@/components/editor/editor-autosave'
import { buildDocPreviewGrantRequest } from '@/lib/doc-preview-grants'
import { fileArtifactSourceKey } from '@/lib/file-artifact-source-key'
import { readRuntimeFileContent } from '@/runtime/runtime-file-read-client'
import { writeRuntimeFile } from '@/runtime/runtime-file-mutation-client'
import { getRemoteFileArgs } from '@/runtime/runtime-file-routing'
import {
  docPreviewGrantFileOwner,
  readDocPreviewArtifactRequest
} from '@/components/browser-pane/workspace-doc/doc-preview-artifact-share'
import { useAppStore } from '@/store'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { getDefaultSettings } from '../../../../shared/constants'
import { FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'

const ROOT = '/home/host/.config/orca/chat-scratch/0123456789abcdef0123456789abcdef'
const PATH = `${ROOT}/usage.html`
const ADDRESS = { worktree: `path:${ROOT}`, relativePath: 'usage.html' }
const target = { kind: 'environment' as const, environmentId: 'env-1' }
const visual = (revision: string, html: string) => ({ ok: true, revision, html, path: PATH })

const replies: Record<string, unknown> = {
  'files.read': { content: '<p>v1</p>', truncated: false, byteLength: 9 },
  'artifacts.getPublishedLink': { status: 'ok', value: null },
  'artifacts.publish': { status: 'ok', value: { change: 'created', item: { shareUrl: 'u' } } }
}

afterEach(cleanup)

it('previews, edits and saves a paired chat visual on its host, then shows the save inline', async () => {
  const visualReads: ((result: unknown) => void)[] = []
  callRuntimeRpc.mockImplementation((_target: unknown, method: string) =>
    method === 'agentSession.readVisual'
      ? new Promise((resolve) => visualReads.push(resolve))
      : Promise.resolve(
          replies[method] ?? { capabilities: [FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY] }
        )
  )
  const [createBrowserTab, openFile] = [vi.fn(), vi.fn()]
  useAppStore.setState({
    createBrowserTab,
    openFile,
    getKnownWorktreeById: () => makeWorktree({ id: 'wt-1', repoId: 'repo-1', path: '/srv/repo' })
  })
  const { container } = render(
    <TooltipProvider>
      <NativeChatInlineVisual
        owner={{ target, sessionId: 'session-1', worktreeId: 'wt-1' }}
        file="usage.html"
        title="Usage"
      />
    </TooltipProvider>
  )
  await waitFor(() => expect(visualReads).toHaveLength(1))
  act(() => visualReads[0](visual('r1', '<p>v1</p>')))

  // Open: the workspace's document preview, granted through the chat folder's own selector.
  fireEvent.click(await screen.findByRole('button', { name: 'Open in new tab' }))
  expect(createBrowserTab.mock.calls[0][2].docLocation).toMatchObject({ filePath: PATH })
  const grant = buildDocPreviewGrantRequest(useAppStore.getState(), 'wt-1', PATH)
  expect(grant?.owner).toMatchObject({ worktreeSelector: ADDRESS.worktree, worktreeRoot: ROOT })
  await (grant && readDocPreviewArtifactRequest(grant, PATH, 'share-key'))

  // Source: the preview's source tab reads and saves on the chat's host by that selector.
  openDocPreviewSource({
    filePath: PATH,
    relativePath: PATH,
    worktreeId: 'wt-1',
    runtimeEnvironmentId: 'env-1',
    externalSshTargetId: null
  })
  const opened = { id: 'f1', isDirty: false, ...openFile.mock.calls[0][0] }
  await readRuntimeFileContent({ target, ...opened })
  await writeRuntimeFile({ target, worktreeId: 'wt-1', worktreePath: null }, PATH, '<p>v2</p>')
  // Share, the editor read and the save use the exact `path:` selector, never `id:path:`.
  for (const method of ['files.readPreview', 'files.read', 'files.write']) {
    const params = expect.objectContaining(ADDRESS)
    expect(callRuntimeRpc).toHaveBeenCalledWith(target, method, params, expect.anything())
  }
  // A workspace containing the host's state folder keeps its own address (explorer drops land).
  const home = getRemoteFileArgs({ target, worktreeId: 'wt-h', worktreePath: '/home/host' }, PATH)
  expect([home?.worktreeSelector, home?.relativePath]).toEqual([
    'id:wt-h',
    PATH.replace('/home/host/', '')
  ])

  // The save lands while a read from before it is in flight: the inline copy reads again after it.
  void readNativeChatVisual({ target, sessionId: 'session-1', file: 'usage.html' })
  await waitFor(() => expect(visualReads).toHaveLength(2))
  useAppStore.setState({ openFiles: [opened] })
  act(() => {
    window.dispatchEvent(
      new CustomEvent(ORCA_EDITOR_FILE_SAVED_EVENT, { detail: { fileId: 'f1', content: '' } })
    )
  })
  act(() => visualReads[1]({ ok: true, revision: 'r1', sizeBytes: 9, path: PATH, unchanged: true }))
  await waitFor(() => expect(visualReads).toHaveLength(3))
  act(() => visualReads[2](visual('r2', '<p>v2</p>')))
  await waitFor(() =>
    expect(container.querySelector('iframe')?.getAttribute('srcdoc')).toContain('<p>v2</p>')
  )

  // Share: the opened preview's key, bytes read after the click, and nothing when that read fails.
  useAppStore.setState({
    settings: { ...getDefaultSettings('/tmp'), artifactSharingEnabled: true },
    orcaProfileAuthStatus: {
      activeProfileId: 'p',
      configured: true,
      state: 'connected',
      persistence: 'none'
    }
  })
  fireEvent.click(screen.getByRole('button', { name: 'Share as artifact' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Generate link' }))
  await waitFor(() => expect(visualReads).toHaveLength(4))
  await act(async () => visualReads[3]({ ok: false, error: 'not_found' }))
  fireEvent.click(screen.getByRole('button', { name: 'Generate link' }))
  await waitFor(() => expect(visualReads).toHaveLength(5))
  act(() => visualReads[4](visual('r3', '<p>v3</p>')))
  const published = expect.objectContaining({
    sourceKey: grant && fileArtifactSourceKey(docPreviewGrantFileOwner(grant.owner), PATH),
    content: '<p>v3</p>'
  })
  await waitFor(() =>
    expect(callRuntimeRpc.mock.calls.filter((call) => call[1] === 'artifacts.publish')).toEqual([
      [{ kind: 'local' }, 'artifacts.publish', published]
    ])
  )
})

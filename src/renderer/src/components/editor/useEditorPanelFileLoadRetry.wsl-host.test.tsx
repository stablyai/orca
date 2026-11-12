// @vitest-environment happy-dom

import { act, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import type { WslHostConnectionState } from '../../../../shared/wsl-host-types'
import type { FileContent } from './editor-panel-content-types'

const host = vi.hoisted((): { state: string | undefined } => ({ state: undefined }))

vi.mock(
  '@/lib/workspace/ownership/worktree-host-connection-phase',
  () => import('./local-host-test-fixture')
)
vi.mock('@/lib/workspace/ownership/workspace-runtime-environment', () => ({
  selectWorkspaceRuntimeEnvironmentId: () => 'wsl-env'
}))
vi.mock('@/store/retained-views/app-state-view', () => ({
  useAppStateValue: <T,>(select: (state: unknown) => T): T =>
    select({
      wslHostStatuses: host.state
        ? { 'wsl-env': { environmentId: 'wsl-env', distro: 'demo', state: host.state } }
        : {}
    })
}))

import { useEditorPanelFileLoadRetry, wslHostRetryConnection } from './useEditorPanelFileLoadRetry'

const FILE: OpenFile = {
  id: 'file-1',
  filePath: '/home/orca/demo/app/main.go',
  relativePath: 'main.go',
  worktreeId: 'repo::/home/orca/demo/app',
  language: 'go',
  isDirty: false,
  mode: 'edit'
}
const UNREACHABLE = 'Could not connect to the remote Orca runtime.'

function Probe({ loadFileContent }: { loadFileContent: () => Promise<void> }): null {
  const [fileContents, setFileContents] = useState<Record<string, FileContent>>({
    [FILE.id]: { content: '', isBinary: false, loadError: UNREACHABLE }
  })
  const openFilesRef = useRef([FILE])
  const fileLoadRetryAttemptsRef = useRef<Record<string, number>>({ [FILE.id]: 3 })
  useEditorPanelFileLoadRetry({
    activeFile: FILE,
    fileContents,
    fileLoadRetryAttemptsRef,
    loadFileContent,
    openFilesRef,
    setFileContents
  })
  return null
}

describe('useEditorPanelFileLoadRetry on a WSL host', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.useFakeTimers()
    container = document.createElement('div')
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    vi.useRealTimers()
  })

  const render = (loadFileContent: () => Promise<void>): void =>
    act(() => root.render(<Probe loadFileContent={loadFileContent} />))

  it('waits while the host connects, then reloads once it answers', async () => {
    const loadFileContent = vi.fn(async () => {})
    host.state = 'connecting'
    render(loadFileContent)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(loadFileContent).not.toHaveBeenCalled()

    host.state = 'ready'
    render(loadFileContent)
    expect(loadFileContent).toHaveBeenCalledWith(
      FILE.filePath,
      FILE.id,
      FILE.worktreeId,
      FILE.relativePath
    )
  })
})

describe('wslHostRetryConnection', () => {
  it.each<[WslHostConnectionState, boolean, string | null]>([
    ['connecting', true, null],
    ['reconnecting', true, null],
    ['ready', false, 'wsl:env-1'],
    ['distro-stopped', false, null],
    ['failed', false, null]
  ])('%s', (state, connecting, connectedEpoch) => {
    expect(wslHostRetryConnection('env-1', state)).toEqual({
      targetId: 'wsl:env-1',
      connecting,
      connectedEpoch
    })
  })

  it('is null for a host that is not a WSL host', () => {
    expect(wslHostRetryConnection(null, undefined)).toBeNull()
    expect(wslHostRetryConnection('ssh-env', undefined)).toBeNull()
  })
})

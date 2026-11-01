// @vitest-environment happy-dom

import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { LocalPathOpenOwner } from '@/lib/local-path-open-guard'
import { getDefaultSettings } from '../../../../shared/constants'
import {
  getConnectionExecutionHostId,
  LOCAL_EXECUTION_HOST_ID
} from '../../../../shared/execution-host'
import { useFileExplorerOpenInApp } from './use-file-explorer-open-in-app'

const openInExternalEditor = vi.fn()
const openedFileId = 'wt-2::/repo/a.ts'
const openInOrca = vi.fn(() => openedFileId)
const makePreviewFilePermanent = vi.fn()

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

type OpenInChosenApp = ReturnType<typeof useFileExplorerOpenInApp>

function Harness({
  owner,
  onReady
}: {
  owner: LocalPathOpenOwner
  onReady: (open: OpenInChosenApp) => void
}): null {
  const open = useFileExplorerOpenInApp('wt-1', owner)
  useEffect(() => {
    onReady(open)
  }, [open, onReady])
  return null
}

let container: HTMLDivElement
let root: Root

function chooseApp(command: string, chosen: string | null): void {
  useAppStore.setState({
    settings: {
      ...getDefaultSettings('/home/user'),
      openInApplications: [{ id: 'app', label: 'App', command }],
      fileExplorerOpenInApplicationId: chosen
    }
  })
}

function renderHook(owner: LocalPathOpenOwner): OpenInChosenApp {
  let open: OpenInChosenApp | null = null
  act(() => {
    root.render(<Harness owner={owner} onReady={(ready) => (open = ready)} />)
  })
  if (!open) {
    throw new Error('hook did not render')
  }
  return open
}

beforeEach(() => {
  openInExternalEditor.mockReset()
  openInExternalEditor.mockResolvedValue({ ok: true })
  openInOrca.mockClear()
  makePreviewFilePermanent.mockReset()
  useAppStore.setState({ makePreviewFilePermanent })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { shell: { openInExternalEditor } }
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('useFileExplorerOpenInApp', () => {
  it('launches the chosen app once and takes the repeated click without relaunching', async () => {
    chooseApp('zed', 'app')
    const open = renderHook(LOCAL_EXECUTION_HOST_ID)

    await act(async () => {
      expect(open('/repo/a.ts', { repeated: false, openInOrca })).toBe(true)
      expect(open('/repo/a.ts', { repeated: true, openInOrca })).toBe(true)
    })

    expect(openInExternalEditor).toHaveBeenCalledTimes(1)
    expect(openInExternalEditor).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/repo/a.ts', command: 'zed' })
    )
    expect(openInOrca).not.toHaveBeenCalled()
  })

  it('opens the file in the Orca editor once when the launch fails', async () => {
    chooseApp('zed', 'app')
    openInExternalEditor.mockResolvedValue({ ok: false, reason: 'launch-failed' })
    const open = renderHook(LOCAL_EXECUTION_HOST_ID)

    await act(async () => {
      expect(open('/repo/a.ts', { repeated: false, openInOrca })).toBe(true)
      expect(open('/repo/a.ts', { repeated: true, openInOrca })).toBe(true)
    })

    expect(openInOrca).toHaveBeenCalledTimes(1)
  })

  it('pins the fallback tab when a double-click reached the file before the launch failed', async () => {
    chooseApp('zed', 'app')
    const settleLaunch: ((result: { ok: boolean; reason?: string }) => void)[] = []
    openInExternalEditor.mockImplementation(
      () => new Promise((resolve) => settleLaunch.push(resolve))
    )
    const open = renderHook(LOCAL_EXECUTION_HOST_ID)

    open('/repo/a.ts', { repeated: false, openInOrca })
    open('/repo/a.ts', { repeated: true, openInOrca })
    await act(async () => settleLaunch[0]({ ok: false, reason: 'launch-failed' }))

    expect(openInOrca).toHaveBeenCalledTimes(1)
    expect(makePreviewFilePermanent).toHaveBeenCalledWith(openedFileId)
  })

  it('opens the file in the Orca editor when the launch throws', async () => {
    chooseApp('zed', 'app')
    openInExternalEditor.mockRejectedValue(new URIError('URI malformed'))
    const open = renderHook(LOCAL_EXECUTION_HOST_ID)

    await act(async () => {
      open('/repo/a.ts', { repeated: false, openInOrca })
      open('/repo/a.ts', { repeated: true, openInOrca })
    })

    expect(openInOrca).toHaveBeenCalledTimes(1)
    expect(makePreviewFilePermanent).toHaveBeenCalledWith(openedFileId)
  })

  it('leaves pinning to the double-click handler when the launch failed before the repeated click', async () => {
    chooseApp('zed', 'app')
    openInExternalEditor.mockResolvedValue({ ok: false, reason: 'launch-failed' })
    const open = renderHook(LOCAL_EXECUTION_HOST_ID)

    await act(async () => {
      open('/repo/a.ts', { repeated: false, openInOrca })
    })
    expect(open('/repo/a.ts', { repeated: true, openInOrca })).toBe(true)

    expect(openInOrca).toHaveBeenCalledTimes(1)
    expect(makePreviewFilePermanent).not.toHaveBeenCalled()
  })

  it('does not pin anything when the launch succeeds', async () => {
    chooseApp('zed', 'app')
    const open = renderHook(LOCAL_EXECUTION_HOST_ID)

    await act(async () => {
      open('/repo/a.ts', { repeated: false, openInOrca })
      open('/repo/a.ts', { repeated: true, openInOrca })
    })

    expect(openInOrca).not.toHaveBeenCalled()
    expect(makePreviewFilePermanent).not.toHaveBeenCalled()
  })

  it('leaves the file to the Orca editor when no app is chosen', () => {
    chooseApp('zed', null)
    const open = renderHook(LOCAL_EXECUTION_HOST_ID)

    expect(open('/repo/a.ts', { repeated: false, openInOrca })).toBe(false)
    expect(open('/repo/a.ts', { repeated: true, openInOrca })).toBe(false)
    expect(openInExternalEditor).not.toHaveBeenCalled()
  })

  it('leaves the file to the Orca editor when the app cannot reach the workspace', () => {
    chooseApp('subl', 'app')
    const open = renderHook(getConnectionExecutionHostId('conn-1'))

    expect(open('/repo/a.ts', { repeated: false, openInOrca })).toBe(false)
    expect(open('/repo/a.ts', { repeated: true, openInOrca })).toBe(false)
    expect(openInExternalEditor).not.toHaveBeenCalled()
  })
})

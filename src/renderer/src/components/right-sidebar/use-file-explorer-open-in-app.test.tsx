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
const openInOrca = vi.fn()

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
  openInOrca.mockReset()
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

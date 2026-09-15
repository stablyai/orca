// @vitest-environment happy-dom
import { act, createElement, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager'
import { TERMINAL_RICH_INPUT_NATIVE_DROP_EVENT } from './terminal-rich-input-native-drop'
import { useTerminalRichInputDrop } from './use-terminal-rich-input-drop'

const { getWorkspaceFileDragPathsMock } = vi.hoisted(() => ({
  getWorkspaceFileDragPathsMock: vi.fn()
}))

vi.mock('@/lib/workspace-file-drag', () => ({
  getWorkspaceFileDragPaths: getWorkspaceFileDragPathsMock
}))

type DropApi = ReturnType<typeof useTerminalRichInputDrop>

function Probe({
  open,
  pane,
  insertPaths,
  onReady
}: {
  open: boolean
  pane: ManagedPane
  insertPaths: (paths: string[]) => void
  onReady: (api: DropApi) => void
}): React.JSX.Element {
  const api = useTerminalRichInputDrop({ open, pane, insertPaths })
  useEffect(() => onReady(api), [api, onReady])
  return createElement('div')
}

async function renderProbe(open = true) {
  const root = createRoot(document.createElement('div'))
  const container = document.createElement('div')
  const pane = { container } as unknown as ManagedPane
  const insertPaths = vi.fn<(paths: string[]) => void>()
  let api: DropApi | null = null
  const onReady = (next: DropApi): void => {
    api = next
  }
  const render = async (nextOpen: boolean): Promise<void> => {
    await act(async () => {
      root.render(createElement(Probe, { open: nextOpen, pane, insertPaths, onReady }))
    })
  }
  await render(open)
  return {
    root,
    container,
    insertPaths,
    latest: () => {
      if (!api) {
        throw new Error('Probe not ready')
      }
      return api
    },
    render
  }
}

function nativeDrop(container: HTMLElement, detail: Record<string, unknown>): void {
  container.dispatchEvent(new CustomEvent(TERMINAL_RICH_INPUT_NATIVE_DROP_EVENT, { detail }))
}

describe('useTerminalRichInputDrop', () => {
  afterEach(() => vi.restoreAllMocks())

  it('tracks the open dataset through updates and unmount', async () => {
    const probe = await renderProbe()
    expect(probe.container.dataset.terminalRichInputOpen).toBe('')

    await probe.render(false)
    expect(probe.container.dataset.terminalRichInputOpen).toBeUndefined()

    act(() => probe.root.unmount())
    expect(probe.container.dataset.terminalRichInputOpen).toBeUndefined()
  })

  it('tracks nested native drops and inserts resolved paths', async () => {
    const probe = await renderProbe()

    act(() => {
      nativeDrop(probe.container, { phase: 'start', imagePending: false, paths: [] })
      nativeDrop(probe.container, { phase: 'start', imagePending: true, paths: [] })
    })
    expect(probe.latest()).toMatchObject({ busy: true, imagePending: true })

    act(() => {
      nativeDrop(probe.container, { phase: 'resolved', imagePending: false, paths: ['/tmp/a'] })
      nativeDrop(probe.container, { phase: 'end', imagePending: false, paths: [] })
    })
    expect(probe.insertPaths).toHaveBeenCalledWith(['/tmp/a'])
    expect(probe.latest()).toMatchObject({ busy: true, imagePending: true })

    act(() => nativeDrop(probe.container, { phase: 'end', imagePending: false, paths: [] }))
    expect(probe.latest()).toMatchObject({ busy: false, imagePending: false })
    probe.root.unmount()
  })

  it('claims workspace file drags and drops', async () => {
    const probe = await renderProbe()
    const dataTransfer = { dropEffect: 'none' } as DataTransfer
    const preventDefault = vi.fn()
    const stopPropagation = vi.fn()
    getWorkspaceFileDragPathsMock.mockReturnValue(['/tmp/a', '/tmp/b'])

    probe.latest().onDragOver({ dataTransfer, preventDefault } as never)
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(dataTransfer.dropEffect).toBe('copy')

    probe.latest().onDrop({ dataTransfer, preventDefault, stopPropagation } as never)
    expect(stopPropagation).toHaveBeenCalledOnce()
    expect(probe.insertPaths).toHaveBeenCalledWith(['/tmp/a', '/tmp/b'])
    probe.root.unmount()
  })
})

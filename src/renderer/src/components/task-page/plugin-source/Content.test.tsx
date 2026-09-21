// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

import { useAppStore } from '@/store'
import { TaskPagePluginSourceContent } from './Content'

const BOARDS = { pluginKey: 'orca-samples.issues', sourceId: 'boards' }

const ITEM = {
  id: 'item-1',
  key: 'BOARD-7',
  title: 'Ship the source bar',
  state: { name: 'In Progress', category: 'in-progress' },
  assignee: null,
  url: null,
  updatedAt: null,
  scopeId: null
}

function stubInvokeTaskSource(invoke: ReturnType<typeof vi.fn>): void {
  vi.stubGlobal(
    'window',
    Object.assign(globalThis.window, {
      api: { plugins: { invokeTaskSource: invoke } }
    })
  )
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  useAppStore.setState(useAppStore.getInitialState(), true)
})

describe('TaskPage contributed source content', () => {
  it('lists the selected source items it loads through the plugin bridge', async () => {
    const invoke = vi.fn().mockResolvedValue({
      ok: true,
      data: { items: [ITEM], nextCursor: null }
    })
    stubInvokeTaskSource(invoke)
    useAppStore.setState({
      pluginTaskSources: [{ ...BOARDS, title: 'Boards' }]
    })
    useAppStore.getState().selectPluginTaskSource(BOARDS)

    render(<TaskPagePluginSourceContent />)

    expect(await screen.findByText('Ship the source bar')).toBeInTheDocument()
    expect(screen.getByText('Boards')).toBeInTheDocument()
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ ...BOARDS, method: 'listItems' }))
  })

  it('surfaces a load failure instead of an empty board', async () => {
    const invoke = vi.fn().mockResolvedValue({
      ok: false,
      code: 'unauthorized',
      message: 'Board token expired.'
    })
    stubInvokeTaskSource(invoke)
    useAppStore.setState({
      pluginTaskSources: [{ ...BOARDS, title: 'Boards' }]
    })
    useAppStore.getState().selectPluginTaskSource(BOARDS)

    render(<TaskPagePluginSourceContent />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Board token expired.')
    expect(screen.queryByText('No tasks found')).not.toBeInTheDocument()
  })
})

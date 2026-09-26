// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'

const { listPythonEnvironments } = vi.hoisted(() => {
  const listPythonEnvironments = vi.fn()
  // The kernel session subscribes to kernel frames when it loads.
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { notebook: { onKernelFrame: () => () => {}, listPythonEnvironments } }
  })
  return { listPythonEnvironments }
})
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('@/store', () => ({ useAppStore: { subscribe: () => () => {} } }))

import { IpynbKernelToolbar } from './IpynbKernelToolbar'
import { trustNotebook } from './ipynb-kernel-session'
import { getSession, setEnvironment, updateSession } from './ipynb-kernel-store'

const FILE = '/repo/nb.ipynb'

afterEach(cleanup)

function renderToolbar(filePath: string) {
  return render(
    <TooltipProvider>
      <IpynbKernelToolbar
        filePath={filePath}
        rootPath="/repo"
        onRunAll={vi.fn()}
        onClearAll={vi.fn()}
      />
    </TooltipProvider>
  )
}

function togglePicker(label: string): void {
  fireEvent.pointerDown(screen.getByRole('button', { name: label }), {
    button: 0,
    ctrlKey: false,
    pointerType: 'mouse'
  })
}

describe('kernel picker trust', () => {
  it('lists workspace envs without running them until the notebook is trusted', async () => {
    const file = '/repo/untrusted.ipynb'
    const venv = { path: '/repo/.venv/bin/python', name: '.venv' }
    listPythonEnvironments.mockResolvedValue({
      workspace: [venv],
      path: [{ path: '/usr/bin/python3', name: 'python3', version: '3.12.1' }]
    })
    renderToolbar(file)

    togglePicker('Select Kernel')
    await screen.findByText('/repo/.venv/bin/python')
    expect(listPythonEnvironments).toHaveBeenLastCalledWith({
      filePath: file,
      rootPath: '/repo',
      runWorkspaceInterpreters: false
    })
    // A version read from nowhere shows the bare env name.
    expect(screen.getByText('.venv')).toBeTruthy()
    // Creating a .venv would reuse, and so run, one the repo shipped.
    expect(
      screen.getByRole('menuitem', { name: 'Create virtual environment…' }).dataset.disabled
    ).toBe('')

    act(() => trustNotebook(file))
    await waitFor(() =>
      expect(listPythonEnvironments).toHaveBeenLastCalledWith({
        filePath: file,
        rootPath: '/repo',
        runWorkspaceInterpreters: true
      })
    )
    expect(
      screen.getByRole('menuitem', { name: 'Create virtual environment…' }).dataset.disabled
    ).toBeUndefined()
  })
})

describe('ipykernel setup dialog', () => {
  it('Cancel drops the waiting cells, as Esc does', () => {
    const venv = { path: '/repo/.venv/bin/python', name: '.venv', version: '3.12.1' }
    setEnvironment(FILE, venv)
    updateSession(FILE, () => ({
      setup: { base: venv, offer: 'install', phase: 'idle', error: null },
      queue: [{ key: 'a', code: 'x' }]
    }))
    render(
      <TooltipProvider>
        <IpynbKernelToolbar
          filePath={FILE}
          rootPath="/repo"
          onRunAll={vi.fn()}
          onClearAll={vi.fn()}
        />
      </TooltipProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(getSession(FILE)).toMatchObject({ status: 'off', setup: null, queue: [] })
    expect(screen.queryByText('Install ipykernel?')).toBeNull()
  })
})

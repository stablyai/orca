// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'

vi.hoisted(() => {
  // The kernel session subscribes to kernel frames when it loads.
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { notebook: { onKernelFrame: () => () => {} } }
  })
})
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('@/store', () => ({ useAppStore: { subscribe: () => () => {} } }))

import { IpynbKernelToolbar } from './IpynbKernelToolbar'
import { getSession, setEnvironment, updateSession } from './ipynb-kernel-store'

const FILE = '/repo/nb.ipynb'

afterEach(cleanup)

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

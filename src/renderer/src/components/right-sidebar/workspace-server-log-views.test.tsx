// @vitest-environment happy-dom

import { useState } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { WorkspaceServerLaunch } from '@/lib/workspace-server-launches'
import type { WorkspaceServerSnapshot } from '../../../../shared/workspace-server-process'
import { WorkspaceServerLogViews } from './workspace-server-log-views'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, params?: Record<string, unknown>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => String(params?.[key] ?? ''))
}))

const entries: WorkspaceServerLaunch[] = [4008, 9097, 9098].map((port, index) => ({
  id: String(port),
  name: ['Frontend', 'Backend', 'Worker'][index] ?? '',
  port,
  runtimeTarget: { kind: 'local' },
  executionHostId: 'local',
  worktreeId: 'workspace',
  repoId: 'repo',
  workspacePath: '/workspace',
  cwd: '/workspace',
  command: 'node server.mjs'
}))
const runs: WorkspaceServerSnapshot[] = entries.map((entry) => ({
  id: `run-${entry.id}`,
  worktreeId: entry.worktreeId,
  port: entry.port,
  name: entry.name,
  status: 'running',
  active: true,
  exitCode: null,
  errorCount: entry.name === 'Backend' ? 1 : 0,
  startedAt: 1000,
  logs: [
    {
      seq: 1,
      time: 1000,
      source: 'stdout',
      level: 'info',
      text: `${entry.name} ready`
    }
  ]
}))

function Host({
  records = entries,
  snapshots = runs,
  onClose = vi.fn()
}: {
  records?: WorkspaceServerLaunch[]
  snapshots?: WorkspaceServerSnapshot[]
  onClose?: () => void
}) {
  const [selected, setSelected] = useState('4008')
  return (
    <TooltipProvider>
      <WorkspaceServerLogViews
        entries={records}
        runs={snapshots}
        selected={selected}
        onSelect={setSelected}
        onClose={onClose}
      />
    </TooltipProvider>
  )
}

afterEach(cleanup)

describe('workspace server log views', () => {
  it('switches independent server logs and exposes errors on inactive tabs', () => {
    render(<Host />)
    const backend = screen.getByRole('tab', { name: 'Backend :9097 · Errors: 1' })
    expect(backend.getAttribute('aria-selected')).toBe('false')
    expect(screen.getByRole('tabpanel').textContent).toContain('Frontend ready')
    fireEvent.mouseDown(backend, { button: 0, ctrlKey: false })
    expect(screen.getByRole('tabpanel').textContent).toContain('Backend ready')
    expect(screen.getByRole('tabpanel').textContent).not.toContain('Frontend ready')
  })

  it('compares distinct servers in two independently selectable panes', () => {
    render(<Host />)
    fireEvent.click(screen.getByRole('button', { name: 'Stacked Split' }))
    const panels = screen.getAllByRole('tabpanel')
    expect(panels).toHaveLength(2)
    expect(panels[0]?.textContent).toContain('Frontend ready')
    expect(panels[1]?.textContent).toContain('Backend ready')
    const comparison = screen.getByRole('tablist', { name: 'Comparison Logs' })
    expect(
      within(comparison).getByRole('tab', { name: 'Frontend :4008' }).hasAttribute('disabled')
    ).toBe(true)
    fireEvent.mouseDown(within(comparison).getByRole('tab', { name: 'Worker :9098' }), {
      button: 0
    })
    expect(screen.getAllByRole('tabpanel')[1]?.textContent).toContain('Worker ready')
    const primary = screen.getByRole('tablist', { name: 'Primary Logs' })
    fireEvent.mouseDown(within(primary).getByRole('tab', { name: 'Worker :9098' }), { button: 0 })
    expect(screen.getAllByRole('tabpanel')[0]?.textContent).toContain('Worker ready')
    expect(screen.getAllByRole('tabpanel')[1]?.textContent).not.toContain('Worker ready')
  })

  it('retains a scrolled log when hidden output arrives and another pane scrolls', () => {
    const view = render(<Host />)
    const frontend = screen.getByRole('tabpanel').querySelector('.overflow-auto')
    if (!(frontend instanceof HTMLElement)) {
      throw new Error('Missing frontend scroll area')
    }
    Object.defineProperties(frontend, {
      scrollHeight: { value: 1000, configurable: true },
      clientHeight: { value: 100, configurable: true }
    })
    frontend.scrollTop = 37
    fireEvent.scroll(frontend)
    fireEvent.mouseDown(screen.getByRole('tab', { name: /Backend/ }), { button: 0 })
    const changed = runs.map((run) =>
      run.port === 4008
        ? {
            ...run,
            logs: [
              ...run.logs,
              {
                seq: 2,
                time: 2000,
                source: 'stderr' as const,
                level: 'info' as const,
                text: 'Frontend next'
              }
            ]
          }
        : run
    )
    view.rerender(<Host snapshots={changed} />)
    fireEvent.mouseDown(screen.getByRole('tab', { name: /Frontend/ }), { button: 0 })
    expect(screen.getByRole('tabpanel').querySelector('.overflow-auto')).toBe(frontend)
    expect(frontend.scrollTop).toBe(37)
    fireEvent.click(screen.getByRole('button', { name: 'Stacked Split' }))
    const backend = screen.getAllByRole('tabpanel')[1]?.querySelector('.overflow-auto')
    if (!(backend instanceof HTMLElement)) {
      throw new Error('Missing backend scroll area')
    }
    backend.scrollTop = 12
    fireEvent.scroll(backend)
    expect(frontend.scrollTop).toBe(37)
  })

  it('closes comparison without closing the primary logs or stopping servers', () => {
    const onClose = vi.fn()
    render(<Host onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'Stacked Split' }))
    const second = screen.getAllByRole('tabpanel')[1]
    if (!second) {
      throw new Error('Missing comparison pane')
    }
    fireEvent.click(within(second).getByRole('button', { name: 'Close Logs' }))
    expect(screen.getAllByRole('tabpanel')).toHaveLength(1)
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Close Logs' }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('falls back to one pane when a compared recipe is removed', () => {
    const view = render(<Host />)
    fireEvent.click(screen.getByRole('button', { name: 'Stacked Split' }))
    view.rerender(<Host records={entries.slice(0, 1)} />)
    expect(screen.getAllByRole('tabpanel')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Stacked Split' }).hasAttribute('disabled')).toBe(
      true
    )
  })
})

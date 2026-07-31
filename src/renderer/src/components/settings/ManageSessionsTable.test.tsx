// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PtyManagementSession } from '../../../../preload/api-types'
import { TooltipProvider } from '../ui/tooltip'
import { ManageSessionsTable } from './ManageSessionsTable'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

function session(incarnationId: string): PtyManagementSession {
  return {
    sessionId: 'colliding-session',
    incarnationId,
    state: 'running',
    shellState: 'ready',
    isAlive: true,
    pid: 123,
    cwd: '/workspace',
    cols: 80,
    rows: 24,
    createdAt: 1,
    protocolVersion: 30
  }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('ManageSessionsTable', () => {
  it('renders same-id daemon incarnations without duplicate React keys', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    render(
      <TooltipProvider>
        <ManageSessionsTable
          sessions={[session('old-incarnation'), session('new-incarnation')]}
          hasLoadedOnce
          sessionCount={2}
          isBusy={false}
          isRefreshing={false}
          daemonBusyKind={null}
          ptyIdToTabId={new Map()}
          onRefresh={vi.fn()}
          onKillAll={vi.fn()}
          onRestartDaemon={vi.fn()}
          onNavigate={vi.fn()}
          onRequestKill={vi.fn()}
        />
      </TooltipProvider>
    )

    expect(screen.getAllByText('colliding-session')).toHaveLength(2)
    expect(
      consoleError.mock.calls.filter((args) =>
        args.some((arg) => /same key|unique "key"/i.test(String(arg)))
      )
    ).toEqual([])
  })
})

// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { RunActionRun } from '@/lib/run-actions/run-actions-store'
import type { OrcaRunAction } from '../../../../shared/workspace-setup/orca-yaml-hook-types'
import { RunActionButtonView, type RunActionButtonViewProps } from './RunActionButtonView'

const noop = (): void => {}
const web: OrcaRunAction = { id: 'web', name: 'Web', command: 'pnpm dev', default: true }
const worker: OrcaRunAction = { id: 'worker', name: 'Worker', command: 'pnpm worker' }

function run(patch: Partial<RunActionRun>): RunActionRun {
  return {
    worktreeId: 'r::/w',
    repoId: 'r',
    actionId: 'web',
    actionName: 'Web',
    tabId: 't',
    status: 'running',
    exitCode: null,
    startedAt: 0,
    ...patch
  }
}

function renderView(props: Partial<RunActionButtonViewProps>): void {
  render(
    <TooltipProvider>
      <RunActionButtonView
        actions={[web, worker]}
        primary={web}
        runs={{}}
        ports={[]}
        shortcut="⌥⌘↩"
        onRun={noop}
        onStop={noop}
        onShowOutput={noop}
        onOpenPorts={noop}
        onOpenPortInBrowser={noop}
        {...props}
      />
    </TooltipProvider>
  )
}

afterEach(cleanup)

describe('RunActionButtonView accessible names', () => {
  it('names the idle primary action and the plain menu', () => {
    renderView({})
    expect(screen.getByRole('button', { name: 'Run Web' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Run actions' })).toBeTruthy()
  })

  it('says the action is running, and how many run, without relying on the dot color', () => {
    renderView({ runs: { web: run({}), worker: run({ actionId: 'worker' }) } })
    expect(screen.getByRole('button', { name: 'Web is running. Show output' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Run actions, 2 running' })).toBeTruthy()
  })

  it('names a stopping and a failed primary action', () => {
    renderView({ runs: { web: run({ status: 'stopping' }) } })
    expect(screen.getByRole('button', { name: 'Web is stopping. Show output' })).toBeTruthy()
    cleanup()
    renderView({ runs: { web: run({ status: 'failed', exitCode: 1 }) } })
    expect(screen.getByRole('button', { name: 'Run Web, last run failed' })).toBeTruthy()
  })

  it('announces a finished run politely', () => {
    renderView({ announcement: 'Web stopped' })
    expect(screen.getByRole('status').textContent).toBe('Web stopped')
  })
})

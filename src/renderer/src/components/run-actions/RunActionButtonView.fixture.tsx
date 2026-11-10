import { defineFixture } from '../../component-fixtures/component-fixture'
import type { RunActionRun } from '@/lib/run-actions/run-actions-store'
import type { OrcaRunAction } from '../../../../shared/orca-yaml-hook-types'
import type { WorkspacePort } from '../../../../shared/workspace-ports'
import { RunActionButtonView, type RunActionButtonViewProps } from './RunActionButtonView'

const noop = (): void => {}

const web: OrcaRunAction = {
  id: 'web',
  name: 'Web',
  command: 'pnpm dev --port $ORCA_PORT',
  default: true
}
const worker: OrcaRunAction = { id: 'worker', name: 'Worker', command: 'pnpm worker:dev' }
const tests: OrcaRunAction = { id: 'test', name: 'Test', command: 'pnpm test:watch' }

function run(action: OrcaRunAction, patch: Partial<RunActionRun>): RunActionRun {
  return {
    worktreeId: 'repo::/w',
    repoId: 'repo',
    actionId: action.id,
    actionName: action.name,
    tabId: `tab-${action.id}`,
    status: 'running',
    exitCode: null,
    startedAt: 0,
    ...patch
  }
}

const port = (value: number, processName: string): WorkspacePort => ({
  kind: 'workspace',
  id: `p-${value}`,
  bindHost: '127.0.0.1',
  connectHost: 'localhost',
  port: value,
  processName,
  protocol: 'http',
  owner: {
    worktreeId: 'repo::/w',
    repoId: 'repo',
    displayName: 'acme-web',
    path: '/w',
    confidence: 'cwd'
  }
})

const base: RunActionButtonViewProps = {
  actions: [web, worker, tests],
  primary: web,
  runs: {},
  ports: [],
  shortcut: '⌥⌘↩',
  onRun: noop,
  onStop: noop,
  onShowOutput: noop,
  onOpenPorts: noop
}

function Bar({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex h-9 items-center justify-end border-b border-border bg-background pr-2">
      {children}
    </div>
  )
}

function openMenu(frame: HTMLElement): void {
  const trigger = frame.querySelector<HTMLButtonElement>('button[aria-label="Run actions"]')
  trigger?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
}

export const idle = defineFixture({
  width: 420,
  render: () => (
    <Bar>
      <RunActionButtonView {...base} />
    </Bar>
  )
})

export const idleMenu = defineFixture({ ...idle, width: 420, interact: openMenu })

const runningProps: RunActionButtonViewProps = {
  ...base,
  runs: { web: run(web, {}), test: run(tests, { status: 'failed', exitCode: 1 }) },
  ports: [port(21230, 'node'), port(21231, 'node')]
}

export const running = defineFixture({
  width: 420,
  render: () => (
    <Bar>
      <RunActionButtonView {...runningProps} />
    </Bar>
  )
})

export const runningMenu = defineFixture({ ...running, interact: openMenu })

export const stoppingMenu = defineFixture({
  width: 420,
  render: () => (
    <Bar>
      <RunActionButtonView {...base} runs={{ web: run(web, { status: 'stopping' }) }} />
    </Bar>
  ),
  interact: openMenu
})

export const singleLegacyAction = defineFixture({
  width: 420,
  render: () => (
    <Bar>
      <RunActionButtonView
        {...base}
        actions={[{ id: 'run', name: 'Run', command: 'npm run dev -- --port $CONDUCTOR_PORT' }]}
        primary={{ id: 'run', name: 'Run', command: 'npm run dev -- --port $CONDUCTOR_PORT' }}
      />
    </Bar>
  )
})

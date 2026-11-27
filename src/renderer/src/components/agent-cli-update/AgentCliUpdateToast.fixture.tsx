import { defineFixture } from '../../component-fixtures/component-fixture'
import {
  AGENT_CLI_UPDATE_AGENTS,
  type AgentCliUpdateAgent
} from '../../../../shared/agent-launch/installation/agent-cli-update'
import { AgentCliUpdateToast, type AgentCliUpdateToastView } from './AgentCliUpdateToast'
import type { AgentCliUpdateToastItem } from './AgentCliUpdateToastList'

const AUTO: [AgentCliUpdateAgent, string, string][] = [
  ['codex', '0.169.1', '0.172.0'],
  ['opencode', '2.0.16', '2.4.1'],
  ['opencode2', '2.0.16', '2.4.1'],
  ['omp', '18.12.6', '19.1.1'],
  ['copilot', '1.0.114', '1.0.115'],
  ['cursor', '2026.11.19', '2026.11.22'],
  ['kilo', '7.8.17', '7.8.32'],
  ['codebuddy', '2.159.0', '2.186.0']
]
const MANUAL: [AgentCliUpdateAgent, string, string, string][] = [
  ['kimi', '0.18.0', '2.7.3', 'brew upgrade kimi-code'],
  ['hermes', '0.23.3', '0.23.4', 'hermes update'],
  ['aug', '0.24.0', '1.2.3', 'npm install -g @augmentcode/auggie@latest']
]

function autoItems(count: number): [AgentCliUpdateAgent, string, string][] {
  const rest = AGENT_CLI_UPDATE_AGENTS.filter((agent) => !AUTO.some(([known]) => known === agent))
  const pool = [...AUTO.map(([agent]) => agent), ...rest]
  return Array.from({ length: count }, (_, index) => {
    const known = AUTO[index]
    return known ?? [pool[index % pool.length], `1.${index}.0`, `1.${index + 3}.2`]
  })
}

function items(view: AgentCliUpdateToastView, count: number): AgentCliUpdateToastItem[] {
  const auto = autoItems(count).map(([agent, from, to], index): AgentCliUpdateToastItem => {
    const status =
      view === 'offer'
        ? 'idle'
        : view === 'done'
          ? 'done'
          : view === 'updating'
            ? index < 3
              ? 'done'
              : index < 6
                ? 'running'
                : 'queued'
            : index === 0 || index === 3
              ? 'failed'
              : 'done'
    return {
      key: `auto-${index}`,
      hostLabel: null,
      agent,
      from,
      to,
      status,
      manualCommand: null,
      onOpenFailure: () => {}
    }
  })
  if (view !== 'offer') {
    return auto
  }
  return [
    ...auto,
    ...MANUAL.map(([agent, from, to, command], index) => ({
      key: `manual-${index}`,
      hostLabel: null,
      agent,
      from,
      to,
      status: 'idle' as const,
      manualCommand: command
    }))
  ]
}

/** Red dashed lines 16px in from each edge: the toast's content edges. */
function Guides({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="relative">
      {children}
      <div className="pointer-events-none absolute inset-y-0 left-4 border-l border-dashed border-destructive" />
      <div className="pointer-events-none absolute inset-y-0 right-4 border-r border-dashed border-destructive" />
    </div>
  )
}

function toast(
  view: AgentCliUpdateToastView,
  count: number,
  listOpen: boolean,
  guides = false,
  width = 360
) {
  const settled = view === 'updating' ? 3 : count
  const element = (
    <AgentCliUpdateToast
      view={view}
      total={count}
      settled={settled}
      failed={view === 'failed' ? 2 : 0}
      canUpdate
      items={() => items(view, count)}
      listOpen={listOpen}
      onToggleList={() => {}}
      onClose={() => {}}
      onUpdate={() => {}}
      onRetry={() => {}}
    />
  )
  return defineFixture({
    width,
    render: () => (guides ? <Guides>{element}</Guides> : element)
  })
}

export const available8 = toast('offer', 8, false)
export const available8List = toast('offer', 8, true)
export const available8Guides = toast('offer', 8, true, true)
export const available30List = toast('offer', 30, true)
export const updating8 = toast('updating', 8, false)
export const updating8List = toast('updating', 8, true)
export const updating30List = toast('updating', 30, true, true)
export const failed8 = toast('failed', 8, false)
export const failed8List = toast('failed', 8, true)
export const failed30List = toast('failed', 30, true)
export const done8 = toast('done', 8, false)
export const done8List = toast('done', 8, true)
export const done30List = toast('done', 30, true)
export const available8Manual = {
  ...toast('offer', 8, true, true),
  interact: async (frame: HTMLElement) => {
    const list = frame.querySelector<HTMLElement>('.overflow-y-auto')
    if (list) {
      list.scrollTop = list.scrollHeight
    }
  }
}
export const narrowAvailable30 = toast('offer', 30, false, true, 343)
export const narrowUpdating30 = toast('updating', 30, true, true, 343)
export const narrowFailed30 = toast('failed', 30, true, true, 343)

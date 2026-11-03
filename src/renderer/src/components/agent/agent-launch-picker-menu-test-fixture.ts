import { resolveAgentStartupPlanInputs } from '../../../../shared/agent-launch/startup/agent-startup-plan-inputs'
import { resolveAgentLaunchCommand } from '../../../../shared/agent-launch/startup/tui-agent-launch-command'
import { tokenizeStartupCommand } from '../../../../shared/agent-launch/startup/tui-agent-startup-shell'
import {
  agentPickerLaunchInputs,
  type AgentPickerDraft,
  type AgentPickerEntry
} from '../../../../shared/agent-launch/picker/agent-launch-picker'

export const entry: AgentPickerEntry = {
  agent: 'codex',
  label: 'Codex',
  rows: [{ agent: 'codex', kind: 'chat' }],
  surfaces: ['chat', 'terminal'],
  defaultSurface: 'chat',
  terminal: {},
  structured: {},
  catalog: {
    origin: 'probe',
    fetchedAt: 1,
    models: [
      { id: 'astra', label: 'Astra', isDefault: true, efforts: [{ value: 'low', label: 'Low' }] }
    ]
  }
}

export function compilePickerTerminalLaunch(draft: AgentPickerDraft, entry: AgentPickerEntry) {
  const compiled = resolveAgentLaunchCommand({
    ...resolveAgentStartupPlanInputs({
      agent: entry.agent,
      settings: { agentCmdOverrides: { [entry.agent]: entry.agent } },
      ...agentPickerLaunchInputs(draft, entry),
      platform: 'linux',
      shell: 'posix',
      isRemote: false
    }),
    shell: 'posix'
  })
  if (!compiled.ok) {
    throw new Error(compiled.error)
  }
  return tokenizeStartupCommand(compiled.command, 'posix')
}

export const codexAskRetainedArgsTokens = [
  'codex',
  '-c',
  'disable_paste_burst=true',
  '-a',
  'on-request',
  '-s',
  'read-only',
  '-c',
  'approvals_reviewer=user',
  '--add-dir',
  'old-owner'
]

export const pickerResizeObservers = new Set<ResizeObserverFixture>()
export const pickerMovementObservers = new Set<IntersectionObserverFixture>()
export class IntersectionObserverFixture implements IntersectionObserver {
  readonly root = null
  readonly rootMargin = ''
  readonly scrollMargin = '0px'
  readonly thresholds = [1]
  targets = new Set<Element>()
  constructor(readonly callback: IntersectionObserverCallback) {
    pickerMovementObservers.add(this)
  }
  observe(target: Element) {
    this.targets.add(target)
  }
  unobserve(target: Element) {
    this.targets.delete(target)
  }
  disconnect() {
    this.targets.clear()
    pickerMovementObservers.delete(this)
  }
  takeRecords(): IntersectionObserverEntry[] {
    return []
  }
}
export class ResizeObserverFixture implements ResizeObserver {
  targets = new Set<Element>()
  constructor(readonly callback: ResizeObserverCallback) {
    pickerResizeObservers.add(this)
  }
  observe(target: Element) {
    this.targets.add(target)
  }
  unobserve(target: Element) {
    this.targets.delete(target)
  }
  disconnect() {
    this.targets.clear()
    pickerResizeObservers.delete(this)
  }
}

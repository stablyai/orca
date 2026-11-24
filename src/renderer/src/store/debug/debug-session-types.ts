export type DebugAdapterId =
  | 'debugpy'
  | 'js-debug'
  | 'codelldb'
  | 'delve'
  | 'lldb-dap'
  | 'netcoredbg'
  | 'rdbg'

export type DebugBreakpoint = {
  line: number
  condition?: string | null
  hitCondition?: string | null
  logMessage?: string | null
  enabled: boolean
}

export type DebugBreakpointState = {
  line: number
  verified: boolean
  message?: string | null
}

export type DebugFunctionBreakpoint = {
  name: string
  condition?: string | null
  hitCondition?: string | null
  enabled: boolean
}

export type DebugSessionStatus = 'idle' | 'starting' | 'running' | 'stopped' | 'terminated'

export type DebugSessionInfo = {
  id: number
  name: string
  adapter: string
  parent?: number | null
  status: Exclude<DebugSessionStatus, 'idle'>
  supportsProgramInput?: boolean
}

export type DebugThreadInfo = {
  id: number
  name: string
}

export type DebugStackFrame = {
  id: number
  name: string
  path?: string | null
  line: number
  column: number
  presentationHint?: string | null
}

export type DebugScope = {
  name: string
  variablesReference: number
  expensive: boolean
}

export type DebugVariable = {
  name: string
  value: string
  typeName?: string | null
  variablesReference: number
  evaluateName?: string | null
}

export type DebugCapabilities = {
  restartFrame: boolean
  stepInTargets: boolean
  functionBreakpoints: boolean
  dataBreakpoints: boolean
  setValue: boolean
  conditionalBreakpoints: boolean
  hitConditionalBreakpoints: boolean
  logPoints: boolean
  hotCodeReplace: boolean
}

export type DebugExceptionFilter = {
  filter: string
  label: string
  description?: string | null
  default: boolean
  supportsCondition: boolean
}

export type DebugSessionExceptionFilters = {
  session: number
  adapter: string
  filters: DebugExceptionFilter[]
}

export type DebugStepInTarget = {
  id: number
  label: string
  line?: number | null
  column?: number | null
  endColumn?: number | null
}

export type DebugInlineStepRange = {
  id: number
  from: number
  to: number
}

export type DebugSmartStepState = {
  sessionId: number
  threadId: number
  targets: DebugStepInTarget[]
  inline: {
    fileKey: string
    line: number
    ranges: DebugInlineStepRange[]
    index: number
  } | null
}

export type DebugEvalContext = 'repl' | 'watch' | 'hover' | 'clipboard'

export type DebugWatchEntry = {
  id: string
  expression: string
  value?: string
  typeName?: string | null
  variablesReference?: number
  error?: string
}

export type DebugDiscoveredLaunchConfig = {
  id: string
  name: string
  source: string
  adapter: DebugAdapterId
  request: 'launch' | 'attach'
  program?: string | null
  args: string[]
  cwd?: string | null
  env: Record<string, string>
  extraJson?: string | null
}

export type DebugLaunchConfig = {
  name: string
  adapter: DebugAdapterId
  request: 'launch' | 'attach'
  program?: string | null
  args: string[]
  cwd?: string | null
  env: Record<string, string>
  extraJson?: string | null
}

export type DebugAdapterStatus = {
  id: DebugAdapterId
  displayName: string
  command: string
  status: 'installed' | 'onPath' | 'missing'
  path?: string | null
  canInstall: boolean
  installMethod: string
  installHint: string
  homepage: string
}

export type DebugMissingAdapterOffer = {
  adapter: DebugAdapterId
  message: string
  config: DebugLaunchConfig
}

let nextConsoleLineId = 1

export type DebugConsoleEntry = {
  id: number
  category: string
  text: string
}

export function createConsoleEntry(category: string, text: string): DebugConsoleEntry {
  nextConsoleLineId += 1
  return { id: nextConsoleLineId, category, text }
}

export type DebugEventPayload = {
  session: number
  event:
    | { kind: 'started'; name: string; adapter: string; parent?: number | null }
    | { kind: 'initialized' }
    | {
        kind: 'stopped'
        threadId: number
        reason: string
        description?: string | null
        allThreadsStopped: boolean
      }
    | { kind: 'continued'; threadId: number; allThreadsContinued: boolean }
    | { kind: 'output'; category: string; output: string }
    | { kind: 'thread'; threadId: number; started: boolean }
    | { kind: 'programInput' }
    | { kind: 'breakpointsChanged'; path: string }
    | { kind: 'terminated' }
    | { kind: 'exited'; code: number }
    | { kind: 'hotCodeReplace'; changeType: string; message: string }
}

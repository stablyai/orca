import type { AgentChoicePatch } from './agent-launch-choices'

export type AutomationLaunchPreferences = Omit<AgentChoicePatch, 'permissionMode'> & {
  permissionMode?: Exclude<AgentChoicePatch['permissionMode'], 'default'>
}
export type AutomationLaunchSetup = {
  surface?: 'chat' | 'terminal'
  extraAgentArgs?: string
  launchPreferences?: AutomationLaunchPreferences
  agentArgs?: string | null
}

export type AutomationArgumentEdit =
  | { kind: 'value'; value: string }
  | { kind: 'empty' }
  | { kind: 'inherit' }

export type AutomationLaunchSourceEdits = {
  arguments?: AutomationArgumentEdit
  legacyArguments?: string
  extraAgentArgs?: string
  retiredChoices?: string[]
}

export type AutomationLaunchSetupPatch = {
  surface?: 'chat' | 'terminal'
  choices?: AgentChoicePatch
  arguments?:
    | { kind: 'legacy-extras'; value: string }
    | { kind: 'value'; value: string }
    | { kind: 'empty' }
    | { kind: 'inherit' }
  sources?: AutomationLaunchSourceEdits
  /** Canonical copies travel inside the strict envelope old hosts reject. */
  copy?: AutomationLaunchSetup
}

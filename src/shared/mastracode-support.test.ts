import { describe, expect, it } from 'vitest'
import {
  recognizeAgentProcess,
  recognizeAgentProcessFromCommandLine
} from './agent-process-recognition'
import { createHookListenerState } from './agent-hook-listener/listener-state'
import { normalizeMastraCodeEvent } from './agent-hook-listener/providers/mastracode-events'
import { buildAgentStartupPlan } from './tui-agent-startup'
import { isTuiAgent, TUI_AGENT_CONFIG } from './tui-agent-config'
import { TUI_AGENT_DISPLAY_NAMES } from './tui-agent-display-names'

describe('Mastra Code support', () => {
  it('registers the CLI as a launchable agent', () => {
    expect(isTuiAgent('mastracode')).toBe(true)
    expect(TUI_AGENT_DISPLAY_NAMES.mastracode).toBe('Mastra Code')
    expect(TUI_AGENT_CONFIG.mastracode).toMatchObject({
      detectCmd: 'mastracode',
      launchCmd: 'mastracode',
      expectedProcess: 'mastracode',
      promptInjectionMode: 'stdin-after-start'
    })
  })

  it('starts the interactive TUI and delivers the task after launch', () => {
    expect(
      buildAgentStartupPlan({
        agent: 'mastracode',
        prompt: 'Fix the failing test',
        cmdOverrides: {},
        platform: 'darwin'
      })
    ).toMatchObject({
      agent: 'mastracode',
      launchCommand: 'mastracode',
      expectedProcess: 'mastracode',
      followupPrompt: 'Fix the failing test'
    })
  })

  it('recognizes Mastra Code foreground processes', () => {
    expect(recognizeAgentProcess('mastracode')).toEqual({
      agent: 'mastracode',
      processName: 'mastracode'
    })
    expect(recognizeAgentProcessFromCommandLine('/usr/local/bin/mastracode')).toEqual({
      agent: 'mastracode',
      processName: 'mastracode'
    })
  })

  it('excludes documented one-shot prompt mode from interactive process detection', () => {
    expect(recognizeAgentProcessFromCommandLine('mastracode --prompt "Review this PR"')).toBeNull()
    expect(
      recognizeAgentProcessFromCommandLine('mastracode -p "Review this PR"', {
        includeHeadlessOneShot: true
      })
    ).toEqual({ agent: 'mastracode', processName: 'mastracode' })
  })

  it('normalizes documented lifecycle events into agent status', () => {
    const state = createHookListenerState()
    const paneKey = 'tab-1:pane-1'

    expect(
      normalizeMastraCodeEvent(state, 'SessionStart', '', paneKey, {
        hook_event_name: 'SessionStart'
      })
    ).toMatchObject({ state: 'done', agentType: 'mastracode', sessionBoundary: true })
    expect(
      normalizeMastraCodeEvent(state, 'UserPromptSubmit', 'Fix the test', paneKey, {
        hook_event_name: 'UserPromptSubmit',
        prompt: 'Fix the test'
      })
    ).toMatchObject({ state: 'working', agentType: 'mastracode', prompt: 'Fix the test' })
    expect(
      normalizeMastraCodeEvent(state, 'PermissionRequest', '', paneKey, {
        hook_event_name: 'PermissionRequest',
        tool_name: 'execute_command',
        tool_input: { command: 'pnpm test' }
      })
    ).toMatchObject({ state: 'waiting', agentType: 'mastracode', toolName: 'execute_command' })
    expect(
      normalizeMastraCodeEvent(state, 'Stop', '', paneKey, {
        hook_event_name: 'Stop',
        stop_reason: 'complete'
      })
    ).toMatchObject({ state: 'done', agentType: 'mastracode' })
  })
})

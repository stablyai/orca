import type { PreloadApi } from '../../../../preload/api-types'

export function createAgentHooksApi(): NonNullable<Partial<PreloadApi>['agentHooks']> {
  const status = (
    agent:
      | 'claude'
      | 'openclaude'
      | 'codex'
      | 'gemini'
      | 'antigravity'
      | 'amp'
      | 'cursor'
      | 'droid'
      | 'command-code'
      | 'grok'
      | 'copilot'
      | 'hermes'
      | 'devin'
      | 'kimi'
      | 'aug'
  ) =>
    Promise.resolve({
      agent,
      state: 'not_installed',
      configPath: '',
      managedHooksPresent: false,
      detail: 'Agent hook status is only available on the Orca server.'
    } as const)
  return {
    claudeStatus: () => status('claude'),
    openClaudeStatus: () => status('openclaude'),
    codexStatus: () => status('codex'),
    geminiStatus: () => status('gemini'),
    antigravityStatus: () => status('antigravity'),
    ampStatus: () => status('amp'),
    cursorStatus: () => status('cursor'),
    droidStatus: () => status('droid'),
    commandCodeStatus: () => status('command-code'),
    grokStatus: () => status('grok'),
    copilotStatus: () => status('copilot'),
    hermesStatus: () => status('hermes'),
    devinStatus: () => status('devin'),
    kimiStatus: () => status('kimi'),
    augStatus: () => status('aug')
  }
}

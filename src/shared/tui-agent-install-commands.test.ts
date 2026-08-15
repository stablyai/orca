import { describe, expect, it } from 'vitest'
import type { TuiAgent } from './types'
import { TUI_AGENT_CONFIG } from './tui-agent-config'
import {
  diffMissingInstallableAgents,
  getAgentInstallCommand,
  getAgentInstallVerifyCommand,
  getInstallableAgentsForPlatform,
  isInstallableTuiAgent,
  toAgentInstallPlatform,
  TUI_AGENT_INSTALL_SPECS
} from './tui-agent-install-commands'

describe('tui-agent-install-commands', () => {
  it('only lists agents that exist in TUI_AGENT_CONFIG', () => {
    for (const spec of TUI_AGENT_INSTALL_SPECS) {
      expect(spec.agent in TUI_AGENT_CONFIG).toBe(true)
      expect(Object.keys(spec.commandByPlatform).length).toBeGreaterThan(0)
    }
  })

  it('resolves platform-specific install commands', () => {
    expect(getAgentInstallCommand('claude', 'linux')).toContain('claude.ai/install.sh')
    expect(getAgentInstallCommand('claude', 'win32')).toContain('install.ps1')
    expect(getAgentInstallCommand('codex', 'darwin')).toBe('npm install -g @openai/codex')
    expect(getAgentInstallCommand('grok', 'win32')).toBeNull()
    expect(getAgentInstallCommand('omp', 'linux')).toContain('omp.sh/install')
    expect(getAgentInstallCommand('goose', 'linux')).toContain('CONFIGURE=false')
    expect(getAgentInstallCommand('cursor', 'darwin')).toContain('cursor.com/install')
    expect(getAgentInstallCommand('cursor', 'win32')).toBeNull()
    expect(getAgentInstallCommand('openclaude', 'linux')).toContain('@gitlawb/openclaude')
  })

  it('uses detectCmd for post-install verification by default', () => {
    expect(getAgentInstallVerifyCommand('codex')).toBe('codex')
    expect(getAgentInstallVerifyCommand('command-code')).toBe('command-code')
    expect(getAgentInstallVerifyCommand('continue')).toBe('cn')
    expect(getAgentInstallVerifyCommand('cursor')).toBe('cursor-agent')
    expect(getAgentInstallVerifyCommand('mistral-vibe')).toBe('vibe')
    expect(getAgentInstallVerifyCommand('qwen-code')).toBe('qwen')
    expect(getAgentInstallVerifyCommand('aug')).toBe('auggie')
    expect(getAgentInstallVerifyCommand('kiro')).toBe('kiro-cli')
  })

  it('classifies install platforms', () => {
    expect(toAgentInstallPlatform('linux')).toBe('linux')
    expect(toAgentInstallPlatform('darwin')).toBe('darwin')
    expect(toAgentInstallPlatform('win32')).toBe('win32')
    expect(toAgentInstallPlatform('android')).toBeNull()
    expect(toAgentInstallPlatform(null)).toBeNull()
  })

  it('diffs local-only agents into installable vs manual-only', () => {
    const localDetected = [
      'claude',
      'codex',
      'omp',
      'claude-agent-teams',
      'grok',
      'hermes'
    ] satisfies TuiAgent[]
    const remoteDetected = ['codex'] satisfies TuiAgent[]

    expect(
      diffMissingInstallableAgents({
        localDetected,
        remoteDetected,
        platform: 'linux'
      })
    ).toEqual({
      installable: ['claude', 'omp', 'grok'],
      manualOnly: ['hermes']
    })
  })

  it('treats agents without a platform command as manual-only', () => {
    expect(
      diffMissingInstallableAgents({
        localDetected: ['grok', 'cursor'],
        remoteDetected: [],
        platform: 'win32'
      })
    ).toEqual({
      installable: [],
      manualOnly: ['grok', 'cursor']
    })
  })

  it('lists only agents installable on the requested platform', () => {
    const linux = getInstallableAgentsForPlatform('linux')
    const win32 = getInstallableAgentsForPlatform('win32')
    expect(linux).toContain('claude')
    expect(linux).toContain('grok')
    expect(linux).toContain('omp')
    expect(linux).toContain('goose')
    expect(win32).toContain('claude')
    expect(win32).toContain('omp')
    expect(win32).not.toContain('grok')
    expect(win32).not.toContain('goose')
    expect(win32).not.toContain('cursor')
  })

  it('guards unknown agent strings', () => {
    expect(isInstallableTuiAgent('claude')).toBe(true)
    expect(isInstallableTuiAgent('omp')).toBe(true)
    expect(isInstallableTuiAgent('hermes')).toBe(false)
    expect(isInstallableTuiAgent('not-an-agent')).toBe(false)
  })
})

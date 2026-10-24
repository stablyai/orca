import { describe, expect, it } from 'vitest'
import {
  AGENT_CHAT_PERMISSION_MODES,
  agentChatPermissionModes,
  loadedChatPermissionSetting,
  newChatPermissionMode,
  savedChatPermissionMode
} from './agent-chat-permission-mode'
import { getDefaultSettings } from './constants'
import { applyAgentPermissionMode } from './tui-agent-permissions'

const CLAUDE_CHAT_PERMISSION_MODES = agentChatPermissionModes('claude')!
const CODEX_CHAT_PERMISSION_MODES = agentChatPermissionModes('codex')!

describe('agent chat permission modes', () => {
  it('orders the picker from least to most access', () => {
    expect(AGENT_CHAT_PERMISSION_MODES).toEqual(['ask', 'accept-edits', 'auto', 'full-access'])
  })

  it('offers Claude every mode, Codex no edits-only mode, ACP agents Ask and Full access', () => {
    expect(agentChatPermissionModes('claude')?.modes).toEqual(AGENT_CHAT_PERMISSION_MODES)
    expect(agentChatPermissionModes('codex')?.modes).toEqual(['ask', 'auto', 'full-access'])
    expect(agentChatPermissionModes('omp')?.modes).toEqual(['ask', 'full-access'])
    expect(agentChatPermissionModes('pi')).toBeNull()
  })

  it('seeds a new chat from the host setting, narrowed to what its agent offers', () => {
    expect(newChatPermissionMode('codex', 'accept-edits')).toBe('ask')
    expect(newChatPermissionMode('claude', 'accept-edits')).toBe('accept-edits')
    expect(newChatPermissionMode('claude', 'auto')).toBe('auto')
    expect(newChatPermissionMode('codex', 'full-access')).toBe('full-access')
    expect(newChatPermissionMode('claude', 'retired-mode')).toBe('ask')
    expect(newChatPermissionMode('claude', undefined)).toBe('ask')
    expect(newChatPermissionMode('omp', 'full-access')).toBe('full-access')
    expect(newChatPermissionMode('omp', 'accept-edits')).toBe('ask')
    expect(newChatPermissionMode('pi', 'full-access')).toBeNull()
  })
})

describe('the mode a chat runs', () => {
  it('asks for a chat saved before modes existed, or with a value its agent cannot run', () => {
    expect(savedChatPermissionMode(CLAUDE_CHAT_PERMISSION_MODES, undefined)).toBe('ask')
    expect(savedChatPermissionMode(CLAUDE_CHAT_PERMISSION_MODES, null)).toBe('ask')
    expect(savedChatPermissionMode(CODEX_CHAT_PERMISSION_MODES, 'accept-edits')).toBe('ask')
    expect(savedChatPermissionMode(CLAUDE_CHAT_PERMISSION_MODES, 'bypassPermissions')).toBe('ask')
  })
})

describe('the new-chat setting as loaded', () => {
  const seed = (terminal: Parameters<typeof loadedChatPermissionSetting>[1]) =>
    loadedChatPermissionSetting(undefined, terminal, 'darwin')
  const yoloWithArgs = (args: { claude?: string; codex?: string; grok?: string }) => {
    const terminal = applyAgentPermissionMode({ mode: 'yolo' })
    Object.assign(terminal.agentDefaultArgs, args)
    return terminal
  }

  it.each([
    ['yolo', 'full-access'],
    ['manual', 'ask']
  ] as const)('seeds %s Agent Permissions as %s', (mode, expected) => {
    expect(seed(applyAgentPermissionMode({ mode }))).toBe(expected)
  })

  it('seeds Full access when Claude and Codex carry their bypass flags among other arguments', () => {
    expect(
      seed(
        yoloWithArgs({
          claude: '--dangerously-skip-permissions --model opus',
          codex: '--model gpt-5 --dangerously-bypass-approvals-and-sandbox'
        })
      )
    ).toBe('full-access')
  })

  it('reads only Claude and Codex, not the other agents', () => {
    expect(seed(yoloWithArgs({ grok: '' }))).toBe('full-access')
    const othersManual = applyAgentPermissionMode({ mode: 'manual' })
    Object.assign(othersManual.agentDefaultArgs, {
      claude: '--dangerously-skip-permissions',
      codex: '--dangerously-bypass-approvals-and-sandbox'
    })
    expect(seed(othersManual)).toBe('full-access')
  })

  it('seeds Ask when Claude or Codex launches without its bypass flag', () => {
    expect(seed(yoloWithArgs({ claude: '' }))).toBe('ask')
    expect(seed(yoloWithArgs({ codex: '--model gpt-5' }))).toBe('ask')
  })

  // Manual leaves custom arguments alone, so the all-agent summary can still be Mixed.
  it('seeds Ask after Manual even when another agent keeps custom arguments', () => {
    const custom = yoloWithArgs({ codex: '--model gpt-5', grok: '--model grok-4' })
    expect(seed(applyAgentPermissionMode({ mode: 'manual', ...custom }))).toBe('ask')
  })

  it('seeds a fresh profile from the shipped Yolo defaults', () => {
    expect(seed(getDefaultSettings('/tmp'))).toBe('full-access')
    expect(getDefaultSettings('/tmp').nativeChatPermissionMode).toBe('full-access')
  })

  it('seeds Auto when both Claude and Codex already use the automatic preset', () => {
    expect(seed(applyAgentPermissionMode({ mode: 'auto' }))).toBe('auto')
    expect(seed({ agentDefaultArgs: { claude: '--permission-mode auto', codex: '' } })).toBe('ask')
    expect(
      loadedChatPermissionSetting(
        'accept-edits',
        applyAgentPermissionMode({ mode: 'auto' }),
        'darwin'
      )
    ).toBe('accept-edits')
  })

  it.each(AGENT_CHAT_PERMISSION_MODES)(
    'keeps a saved %s whatever Agent Permissions say',
    (mode) => {
      for (const terminal of ['manual', 'yolo'] as const) {
        expect(
          loadedChatPermissionSetting(mode, applyAgentPermissionMode({ mode: terminal }), 'darwin')
        ).toBe(mode)
      }
    }
  )

  it.each(['future', null, 42, 'bypass'])('reads an unknown saved %s as Ask', (value) => {
    expect(loadedChatPermissionSetting(value, getDefaultSettings('/tmp'), 'darwin')).toBe('ask')
  })
})

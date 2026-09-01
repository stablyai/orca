import { describe, it, expect } from 'vitest'
import type { CustomTuiAgent, CustomTuiAgentId } from '../../../../shared/tui-agent'
import { canToggleNativeChat } from './native-chat-availability'
import { isNativeChatTranscriptLocalReadable } from '@/lib/native-chat-transcript-readability'

const CUSTOM_CLAUDE_ID = 'custom-agent:claude:11111111-1111-4111-8111-111111111111'
const CUSTOM_GEMINI_ID = 'custom-agent:gemini:22222222-2222-4222-8222-222222222222'
const CUSTOM_GROK_ID = 'custom-agent:grok:33333333-3333-4333-8333-333333333333'
const UNCATALOGED_CUSTOM_ID = 'custom-agent:claude:44444444-4444-4444-8444-444444444444'

function customAgent(id: CustomTuiAgentId, baseAgent: CustomTuiAgent['baseAgent']): CustomTuiAgent {
  return { id, baseAgent, label: 'Custom', args: '', env: {}, syncEnv: false }
}

describe('canToggleNativeChat', () => {
  it('allows a terminal launched with a supported coding agent', () => {
    expect(
      canToggleNativeChat({
        experimentalNativeChatEnabled: true,
        contentType: 'terminal',
        launchAgent: 'claude'
      })
    ).toBe(true)
  })

  it('allows a terminal with a live detected supported agent but no launchAgent', () => {
    expect(
      canToggleNativeChat({
        experimentalNativeChatEnabled: true,
        contentType: 'terminal',
        launchAgent: null,
        detectedAgent: 'codex'
      })
    ).toBe(true)
  })

  it('allows a terminal with a resolved title/foreground supported agent before hooks arrive', () => {
    expect(
      canToggleNativeChat({
        experimentalNativeChatEnabled: true,
        contentType: 'terminal',
        launchAgent: null,
        resolvedAgent: 'claude'
      })
    ).toBe(true)
  })

  it('allows the OpenClaude variant', () => {
    expect(
      canToggleNativeChat({
        experimentalNativeChatEnabled: true,
        contentType: 'terminal',
        launchAgent: 'openclaude'
      })
    ).toBe(true)
  })

  it('allows an existing chat view to toggle back after live signals are gone', () => {
    expect(
      canToggleNativeChat({
        experimentalNativeChatEnabled: true,
        contentType: 'terminal',
        launchAgent: null,
        isChatViewMode: true
      })
    ).toBe(true)
  })

  it('accepts local Grok once native chat can parse its transcript', () => {
    expect(
      canToggleNativeChat({
        experimentalNativeChatEnabled: true,
        contentType: 'terminal',
        launchAgent: 'grok',
        nativeChatTranscriptIsLocalReadable: isNativeChatTranscriptLocalReadable(null)
      })
    ).toBe(true)
  })

  it('accepts runtime-owned Grok because Model B reads the transcript locally', () => {
    expect(
      canToggleNativeChat({
        experimentalNativeChatEnabled: true,
        contentType: 'terminal',
        launchAgent: 'grok',
        nativeChatTranscriptIsLocalReadable:
          isNativeChatTranscriptLocalReadable('runtime-ssh-env-1')
      })
    ).toBe(true)
  })

  it('rejects Model-A SSH Grok when its transcript is remote-only', () => {
    expect(
      canToggleNativeChat({
        experimentalNativeChatEnabled: true,
        contentType: 'terminal',
        launchAgent: 'grok',
        nativeChatTranscriptIsLocalReadable: isNativeChatTranscriptLocalReadable('ssh-target-1')
      })
    ).toBe(false)
  })

  // Why: omp discloses no hook transcript path either, so its session file is
  // only reachable when this process can read the agent's disk.
  it('rejects Model-A SSH omp but accepts it local and runtime-owned', () => {
    const forConnection = (connectionId: string | null): boolean =>
      canToggleNativeChat({
        experimentalNativeChatEnabled: true,
        contentType: 'terminal',
        launchAgent: 'omp',
        nativeChatTranscriptIsLocalReadable: isNativeChatTranscriptLocalReadable(connectionId)
      })
    expect(forConnection('ssh-target-1')).toBe(false)
    expect(forConnection(null)).toBe(true)
    expect(forConnection('runtime-ssh-env-1')).toBe(true)
  })

  it('lets an existing Model-A SSH Grok chat toggle back to terminal', () => {
    expect(
      canToggleNativeChat({
        experimentalNativeChatEnabled: true,
        contentType: 'terminal',
        launchAgent: 'grok',
        nativeChatTranscriptIsLocalReadable: false,
        isChatViewMode: true
      })
    ).toBe(true)
  })

  it.each(['gemini', 'opencode'] as const)(
    'rejects unsupported agent %s detected live',
    (agent) => {
      expect(
        canToggleNativeChat({
          experimentalNativeChatEnabled: true,
          contentType: 'terminal',
          launchAgent: null,
          detectedAgent: agent
        })
      ).toBe(false)
    }
  )

  it('accepts Grok when resolved from the title', () => {
    expect(
      canToggleNativeChat({
        experimentalNativeChatEnabled: true,
        contentType: 'terminal',
        launchAgent: null,
        resolvedAgent: 'grok',
        nativeChatTranscriptIsLocalReadable: true
      })
    ).toBe(true)
  })

  it('rejects a stale supported title when live detection found an unsupported agent', () => {
    expect(
      canToggleNativeChat({
        experimentalNativeChatEnabled: true,
        contentType: 'terminal',
        launchAgent: null,
        detectedAgent: 'gemini',
        resolvedAgent: 'codex'
      })
    ).toBe(false)
  })

  it('rejects stale launch metadata when live detection found an unsupported agent', () => {
    expect(
      canToggleNativeChat({
        experimentalNativeChatEnabled: true,
        contentType: 'terminal',
        launchAgent: 'codex',
        detectedAgent: 'gemini'
      })
    ).toBe(false)
  })

  it('rejects a stale supported title when launch metadata names an unsupported agent', () => {
    expect(
      canToggleNativeChat({
        experimentalNativeChatEnabled: true,
        contentType: 'terminal',
        launchAgent: 'gemini',
        resolvedAgent: 'claude'
      })
    ).toBe(false)
  })

  it('rejects otherwise eligible terminals while the experimental flag is off', () => {
    expect(
      canToggleNativeChat({
        experimentalNativeChatEnabled: false,
        contentType: 'terminal',
        launchAgent: 'claude'
      })
    ).toBe(false)
  })

  it('rejects a plain shell terminal with no agent', () => {
    expect(
      canToggleNativeChat({
        experimentalNativeChatEnabled: true,
        contentType: 'terminal',
        launchAgent: null,
        detectedAgent: null
      })
    ).toBe(false)
  })

  it('rejects a plain shell terminal with everything omitted', () => {
    expect(
      canToggleNativeChat({ experimentalNativeChatEnabled: true, contentType: 'terminal' })
    ).toBe(false)
  })

  it('rejects an editor tab even if a supported agent hint were somehow present', () => {
    expect(
      canToggleNativeChat({
        experimentalNativeChatEnabled: true,
        contentType: 'editor',
        launchAgent: 'codex',
        detectedAgent: 'codex'
      })
    ).toBe(false)
  })

  it('rejects a browser tab', () => {
    expect(
      canToggleNativeChat({
        experimentalNativeChatEnabled: true,
        contentType: 'browser',
        detectedAgent: 'claude'
      })
    ).toBe(false)
  })

  it('allows a live custom agent based on Claude', () => {
    expect(
      canToggleNativeChat({
        experimentalNativeChatEnabled: true,
        contentType: 'terminal',
        launchAgent: CUSTOM_CLAUDE_ID,
        customTuiAgents: [customAgent(CUSTOM_CLAUDE_ID, 'claude')]
      })
    ).toBe(true)
  })

  it('allows a custom agent detected live, and one still known only as a tombstone', () => {
    expect(
      canToggleNativeChat({
        experimentalNativeChatEnabled: true,
        contentType: 'terminal',
        detectedAgent: CUSTOM_CLAUDE_ID,
        customTuiAgents: [customAgent(CUSTOM_CLAUDE_ID, 'claude')]
      })
    ).toBe(true)
    // A deleted definition keeps the base, so a still-running pane keeps its chat.
    expect(
      canToggleNativeChat({
        experimentalNativeChatEnabled: true,
        contentType: 'terminal',
        launchAgent: CUSTOM_CLAUDE_ID,
        deletedCustomTuiAgents: [
          { id: CUSTOM_CLAUDE_ID, baseAgent: 'claude', label: 'Custom', deletedAt: 1 }
        ]
      })
    ).toBe(true)
  })

  // Fail closed: the encoded base in the id never grants a harness on its own.
  it('rejects a custom agent id with no catalog entry at all', () => {
    expect(
      canToggleNativeChat({
        experimentalNativeChatEnabled: true,
        contentType: 'terminal',
        launchAgent: UNCATALOGED_CUSTOM_ID,
        customTuiAgents: [customAgent(CUSTOM_CLAUDE_ID, 'claude')],
        deletedCustomTuiAgents: []
      })
    ).toBe(false)
  })

  it('rejects a live custom agent based on an unsupported agent (Gemini)', () => {
    expect(
      canToggleNativeChat({
        experimentalNativeChatEnabled: true,
        contentType: 'terminal',
        launchAgent: CUSTOM_GEMINI_ID,
        customTuiAgents: [customAgent(CUSTOM_GEMINI_ID, 'gemini')]
      })
    ).toBe(false)
  })

  it('applies the base agent transcript-locality rule to a custom Grok agent', () => {
    const forConnection = (connectionId: string | null): boolean =>
      canToggleNativeChat({
        experimentalNativeChatEnabled: true,
        contentType: 'terminal',
        launchAgent: CUSTOM_GROK_ID,
        customTuiAgents: [customAgent(CUSTOM_GROK_ID, 'grok')],
        nativeChatTranscriptIsLocalReadable: isNativeChatTranscriptLocalReadable(connectionId)
      })
    expect(forConnection('ssh-target-1')).toBe(false)
    expect(forConnection(null)).toBe(true)
  })
})

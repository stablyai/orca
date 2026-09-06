import { describe, it, expect } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import {
  resolveNativeChatSession,
  resolveEffectiveNativeChatSessionId
} from './native-chat-pane-resolution'

function entry(
  overrides: Partial<AgentStatusEntry> & Pick<AgentStatusEntry, 'paneKey'>
): AgentStatusEntry {
  return {
    state: 'working',
    prompt: '',
    updatedAt: 0,
    stateStartedAt: 0,
    stateHistory: [],
    ...overrides
  }
}

describe('resolveNativeChatSession', () => {
  it('resolves a pane with a captured Claude session', () => {
    const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111'
    expect(
      resolveNativeChatSession({
        paneKey,
        launchAgent: 'claude',
        agentStatusEntry: entry({
          paneKey,
          agentType: 'claude',
          providerSession: { key: 'session_id', id: 'sess-abc' }
        }),
        ptyId: 'pty-1'
      })
    ).toEqual({
      agent: 'claude',
      sessionId: 'sess-abc',
      transcriptPath: null,
      ptyId: 'pty-1',
      paneKey
    })
  })

  it('surfaces the hook transcriptPath when the providerSession carries one', () => {
    const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111'
    expect(
      resolveNativeChatSession({
        paneKey,
        launchAgent: 'claude',
        agentStatusEntry: entry({
          paneKey,
          agentType: 'claude',
          providerSession: {
            key: 'session_id',
            id: 'sess-abc',
            transcriptPath: '/home/u/.claude/projects/slug/real-uuid.jsonl'
          }
        }),
        ptyId: 'pty-1'
      })
    ).toEqual({
      agent: 'claude',
      sessionId: 'sess-abc',
      transcriptPath: '/home/u/.claude/projects/slug/real-uuid.jsonl',
      ptyId: 'pty-1',
      paneKey
    })
  })

  it('resolves a just-launched pane with sessionId null', () => {
    const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111'
    expect(
      resolveNativeChatSession({
        paneKey,
        launchAgent: 'claude',
        // Entry exists (agent launched) but no providerSession reported yet.
        agentStatusEntry: entry({ paneKey, agentType: 'claude' }),
        ptyId: 'pty-1'
      })
    ).toEqual({ agent: 'claude', sessionId: null, transcriptPath: null, ptyId: 'pty-1', paneKey })
  })

  it('resolves two split leaves independently to their own values', () => {
    const leftKey = 'tab-1:11111111-1111-4111-8111-111111111111'
    const rightKey = 'tab-1:22222222-2222-4222-8222-222222222222'
    const left = resolveNativeChatSession({
      paneKey: leftKey,
      launchAgent: 'claude',
      agentStatusEntry: entry({
        paneKey: leftKey,
        agentType: 'claude',
        providerSession: { key: 'session_id', id: 'left-sess' }
      }),
      ptyId: 'pty-left'
    })
    const right = resolveNativeChatSession({
      paneKey: rightKey,
      launchAgent: 'codex',
      agentStatusEntry: entry({
        paneKey: rightKey,
        agentType: 'codex',
        providerSession: { key: 'session_id', id: 'right-sess' }
      }),
      ptyId: 'pty-right'
    })
    expect(left).toEqual({
      agent: 'claude',
      sessionId: 'left-sess',
      transcriptPath: null,
      ptyId: 'pty-left',
      paneKey: leftKey
    })
    expect(right).toEqual({
      agent: 'codex',
      sessionId: 'right-sess',
      transcriptPath: null,
      ptyId: 'pty-right',
      paneKey: rightKey
    })
  })

  it('derives a supported agent from the status entry when no launchAgent is set', () => {
    const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111'
    expect(
      resolveNativeChatSession({
        paneKey,
        launchAgent: null,
        agentStatusEntry: entry({
          paneKey,
          agentType: 'codex',
          providerSession: { key: 'session_id', id: 'codex-1' }
        }),
        ptyId: 'pty-1'
      })
    ).toEqual({
      agent: 'codex',
      sessionId: 'codex-1',
      transcriptPath: null,
      ptyId: 'pty-1',
      paneKey
    })
  })

  it.each(['codex', 'claude', 'openclaude'] as TuiAgent[])(
    'resolves supported title fallback %s when no hook or launch identity exists',
    (resolvedAgent) => {
      const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111'
      expect(
        resolveNativeChatSession({
          paneKey,
          launchAgent: null,
          resolvedAgent,
          ptyId: 'pty-1'
        })
      ).toEqual({
        agent: resolvedAgent,
        sessionId: null,
        transcriptPath: null,
        ptyId: 'pty-1',
        paneKey
      })
    }
  )

  it('does not resolve unsupported title fallback gemini', () => {
    expect(
      resolveNativeChatSession({
        paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
        launchAgent: null,
        resolvedAgent: 'gemini',
        ptyId: 'pty-1'
      })
    ).toBeNull()
  })

  it('resolves Grok from title fallback once native chat supports its transcript', () => {
    expect(
      resolveNativeChatSession({
        paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
        launchAgent: null,
        resolvedAgent: 'grok',
        ptyId: 'pty-1'
      })
    ).toMatchObject({
      agent: 'grok',
      sessionId: null,
      ptyId: 'pty-1'
    })
  })

  it('does not resolve an unsupported live status entry', () => {
    const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111'
    expect(
      resolveNativeChatSession({
        paneKey,
        launchAgent: null,
        agentStatusEntry: entry({
          paneKey,
          agentType: 'gemini',
          providerSession: { key: 'session_id', id: 'g-1' }
        }),
        ptyId: 'pty-1'
      })
    ).toBeNull()
  })

  it('does not fall back to a supported title agent when live status is unsupported', () => {
    const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111'
    expect(
      resolveNativeChatSession({
        paneKey,
        launchAgent: null,
        agentStatusEntry: entry({
          paneKey,
          agentType: 'gemini',
          providerSession: { key: 'session_id', id: 'g-1' }
        }),
        resolvedAgent: 'codex',
        ptyId: 'pty-1'
      })
    ).toBeNull()
  })

  it('does not fall back to a supported launch agent when live status is unsupported', () => {
    const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111'
    expect(
      resolveNativeChatSession({
        paneKey,
        launchAgent: 'codex',
        agentStatusEntry: entry({
          paneKey,
          agentType: 'gemini',
          providerSession: { key: 'session_id', id: 'g-1' }
        }),
        resolvedAgent: 'claude',
        ptyId: 'pty-1'
      })
    ).toBeNull()
  })

  it('resolves a Grok launch agent', () => {
    expect(
      resolveNativeChatSession({
        paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
        launchAgent: 'grok',
        ptyId: 'pty-1'
      })
    ).toMatchObject({
      agent: 'grok',
      sessionId: null,
      ptyId: 'pty-1'
    })
  })

  it('keeps Grok launch identity ahead of a different title agent', () => {
    expect(
      resolveNativeChatSession({
        paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
        launchAgent: 'grok',
        resolvedAgent: 'codex',
        ptyId: 'pty-1'
      })
    ).toMatchObject({
      agent: 'grok',
      sessionId: null,
      ptyId: 'pty-1'
    })
  })

  it('keeps launch identity ahead of the title fallback', () => {
    const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111'
    expect(
      resolveNativeChatSession({
        paneKey,
        launchAgent: 'claude',
        resolvedAgent: 'codex',
        ptyId: 'pty-1'
      })?.agent
    ).toBe('claude')
  })

  it('keeps live hook identity and provider session ahead of the title fallback', () => {
    const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111'
    expect(
      resolveNativeChatSession({
        paneKey,
        launchAgent: 'claude',
        agentStatusEntry: entry({
          paneKey,
          agentType: 'codex',
          providerSession: { key: 'session_id', id: 'codex-live' }
        }),
        resolvedAgent: 'claude',
        ptyId: 'pty-1'
      })
    ).toEqual({
      agent: 'codex',
      sessionId: 'codex-live',
      transcriptPath: null,
      ptyId: 'pty-1',
      paneKey
    })
  })

  it('returns null for a non-agent pane (no launchAgent, no entry)', () => {
    expect(
      resolveNativeChatSession({
        paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
        launchAgent: null,
        ptyId: 'pty-1'
      })
    ).toBeNull()
  })
})

describe('resolveEffectiveNativeChatSessionId', () => {
  it('prefers the resolved omp identity over the hook-derived sessionId', () => {
    expect(resolveEffectiveNativeChatSessionId('hook-session', 'resolved-session')).toBe(
      'resolved-session'
    )
  })

  it('falls back to the hook-derived sessionId when no resolved identity exists (non-omp panes, or before ownership ever resolves)', () => {
    expect(resolveEffectiveNativeChatSessionId('hook-session', null)).toBe('hook-session')
  })

  it('returns null when no source has a value (Bug 1: never a stale session id)', () => {
    expect(resolveEffectiveNativeChatSessionId(null, null, null)).toBeNull()
  })

  it("prefers the id OMP itself published over the on-disk resolver's guess", () => {
    // session_info_update carries session.sessionId from the child that owns
    // the pane — ground truth. The on-disk resolver degrades to an mtime guess
    // whenever no breadcrumb is available, and a cwd with several sessions can
    // make that guess pick the wrong transcript.
    expect(resolveEffectiveNativeChatSessionId('hook-session', 'mtime-guess', 'wire-session')).toBe(
      'wire-session'
    )
  })

  it('keeps the resolved identity while OMP has published no session id yet', () => {
    // The frame only arrives once a builtin republishes the session, so the
    // resolver stays the answer for the whole pre-command life of the pane.
    expect(resolveEffectiveNativeChatSessionId('hook-session', 'resolved-session', null)).toBe(
      'resolved-session'
    )
  })
})

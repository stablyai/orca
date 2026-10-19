import { describe, expect, it } from 'vitest'
import { surfaceNativeChatCommandOutputs } from './native-chat-command-output'
import { stripNoiseMessages } from './native-chat-noise'
import type { NativeChatMessage } from './native-chat-types'

// The two user rows OpenClaude 0.31.0 writes for `/context` (its caveat row is
// `isMeta` and never decoded), as the transcript decoder emits them.
const CONTEXT_ENVELOPE =
  '<command-name>/context</command-name>\n            <command-message>context</command-message>\n            <command-args></command-args>'
const CONTEXT_STDOUT =
  '<local-command-stdout> \u001b[1mContext Usage\u001b[22m\n\u001b[38;5;244m\u26c1 \u26c1 \u26c1 \u26c1 \u26c1 \u26c1 \u001b[38;5;246m\u26c1 \u26c1 \u26c1 \u26c1 \u001b[39m  \u001b[38;5;246mgpt-4o \u00b7 16.6k/128k tokens (13%)\u001b[39m\n\n\u001b[38;5;246m\u26c1 \u26c1 \u26c0 \u001b[38;5;220m\u26c0 \u001b[38;5;246m\u26f6 \u26f6 \u26f6 \u26f6 \u26f6 \u26f6 \u001b[39m  \u001b[38;5;246m\u001b[3mEstimated usage by category\u001b[23m\u001b[39m\n                      \u001b[38;5;244m\u26c1\u001b[39m System prompt: \u001b[38;5;246m7.9k tokens (6.1%)\u001b[39m\n\u001b[38;5;246m\u26f6 \u26f6 \u26f6 \u26f6 \u26f6 \u26f6 \u26f6 \u26f6 \u26f6 \u26f6 \u001b[39m  \u001b[38;5;246m\u26c1\u001b[39m System tools: \u001b[38;5;246m8.5k tokens (6.6%)\u001b[39m\n                      \u001b[38;5;220m\u26c1\u001b[39m Skills: \u001b[38;5;246m304 tokens (0.2%)\u001b[39m\n\u001b[38;5;246m\u26f6 \u26f6 \u26f6 \u26f6 \u26f6 \u26f6 \u26f6 \u26f6 \u26f6 \u26f6 \u001b[39m  \u001b[38;5;246m\u26f6\u001b[39m Free space: \u001b[38;5;246m65k (50.8%)\u001b[39m\n                      \u001b[38;5;246m\u26dd Autocompact buffer: 46.4k tokens (36.2%)\u001b[39m\n\u001b[38;5;246m\u26f6 \u26f6 \u26f6 \u26f6 \u26f6 \u26f6 \u26f6 \u26f6 \u26f6 \u26f6 \u001b[39m\n\n\u001b[38;5;246m\u26f6 \u26f6 \u26f6 \u26f6 \u26f6 \u26f6 \u26f6 \u26f6 \u26f6 \u26f6 \u001b[39m\n\n\u001b[38;5;246m\u26f6 \u26f6 \u26f6 \u26f6 \u26dd \u26dd \u26dd \u26dd \u26dd \u26dd \u001b[39m\n\n\u001b[38;5;246m\u26dd \u26dd \u26dd \u26dd \u26dd \u26dd \u26dd \u26dd \u26dd \u26dd \u001b[39m\n\n\u001b[38;5;246m\u26dd \u26dd \u26dd \u26dd \u26dd \u26dd \u26dd \u26dd \u26dd \u26dd \u001b[39m\n\n\u001b[38;5;246m\u26dd \u26dd \u26dd \u26dd \u26dd \u26dd \u26dd \u26dd \u26dd \u26dd \u001b[39m\n\n\n\u001b[1mSkills\u001b[22m\u001b[38;5;246m \u00b7 /skills\u001b[39m</local-command-stdout>'

function userTurn(
  id: string,
  text: string,
  timestamp: number | null = 100,
  parentId?: string
): NativeChatMessage {
  return {
    id,
    role: 'user',
    blocks: [{ type: 'text', text }],
    timestamp,
    source: 'transcript',
    ...(parentId ? { parentId } : {})
  }
}

const envelope = (name: string, id = 'env', timestamp = 100): NativeChatMessage =>
  userTurn(id, CONTEXT_ENVELOPE.replaceAll('context', name), timestamp)

const reply = (id: string, parentId: string | undefined, timestamp = 100): NativeChatMessage =>
  userTurn(id, CONTEXT_STDOUT, timestamp, parentId)

const MODEL_STDOUT = '<local-command-stdout>Set model to gpt-4o</local-command-stdout>'

describe('surfaceNativeChatCommandOutputs', () => {
  it("shows OpenClaude's /context report as plain command output", () => {
    const [shown] = surfaceNativeChatCommandOutputs(
      [reply('out', 'env'), envelope('context')],
      'openclaude'
    )
    expect(shown).toMatchObject({ id: 'out', role: 'system' })
    const block = shown?.blocks[0]
    expect(block).toMatchObject({ type: 'text', presentation: 'command-output' })
    const text = block?.type === 'text' ? block.text : ''
    expect(text).not.toContain('\u001b')
    expect(text).not.toContain('local-command-stdout')
    // Column layout survives: the legend stays indented past the grid.
    expect(text.split('\n').slice(0, 5)).toEqual([
      'Context Usage',
      '\u26c1 \u26c1 \u26c1 \u26c1 \u26c1 \u26c1 \u26c1 \u26c1 \u26c1 \u26c1   gpt-4o \u00b7 16.6k/128k tokens (13%)',
      '',
      '\u26c1 \u26c1 \u26c0 \u26c0 \u26f6 \u26f6 \u26f6 \u26f6 \u26f6 \u26f6   Estimated usage by category',
      '                      \u26c1 System prompt: 7.9k tokens (6.1%)'
    ])
  })

  it('survives the noise filter while the command envelope stays hidden', () => {
    const visible = stripNoiseMessages(
      surfaceNativeChatCommandOutputs([envelope('context'), reply('out', 'env')], 'openclaude')
    )
    expect(visible.map(({ id }) => id)).toEqual(['out'])
  })

  it('pairs each reply with the row it links to, whatever the timestamps say', () => {
    // One batch, one timestamp, sorted by id: each reply sits beside the other
    // command, and the /model command is the newest row at the /context reply.
    const modelReply = userTurn('a-model-out', MODEL_STDOUT, 100, 'd-model')
    const messages = [
      modelReply,
      envelope('context', 'b-context', 100),
      reply('c-context-out', 'b-context', 100),
      envelope('model', 'd-model', 100)
    ]
    const surfaced = surfaceNativeChatCommandOutputs(messages, 'openclaude')
    expect(surfaced.find(({ id }) => id === 'c-context-out')?.role).toBe('system')
    // Replies to commands whose effect is the feedback stay hidden.
    expect(surfaced.find(({ id }) => id === 'a-model-out')).toBe(modelReply)
    // A reply stamped before its command row still answers it.
    const early = [reply('out', 'env', 99), envelope('context', 'env', 100)]
    expect(surfaceNativeChatCommandOutputs(early, 'openclaude')[0]?.role).toBe('system')
  })

  it('leaves a reply hidden without a link to a loaded /context row', () => {
    // An older host sends no link, even for a reply right after its command.
    const unlinked = [envelope('context'), reply('out', undefined)]
    expect(surfaceNativeChatCommandOutputs(unlinked, 'openclaude')).toBe(unlinked)
    // The command row fell outside the loaded tail window.
    const windowed = [reply('out', 'env-before-window'), envelope('context', 'env-2', 200)]
    expect(surfaceNativeChatCommandOutputs(windowed, 'openclaude')).toBe(windowed)
    // Linked to a row that is not a command envelope.
    const prose = [userTurn('env', 'what is /context'), reply('out', 'env')]
    expect(surfaceNativeChatCommandOutputs(prose, 'openclaude')).toBe(prose)
  })

  it('leaves agents that declare no transcript reply untouched', () => {
    const messages = [envelope('context'), reply('out', 'env')]
    // Claude's TUI writes no reply row; one that appears is left to the noise filter.
    expect(surfaceNativeChatCommandOutputs(messages, 'claude')).toBe(messages)
    // OMP's /context is answered by the composer, never by a transcript row.
    expect(surfaceNativeChatCommandOutputs(messages, 'omp')).toBe(messages)
  })
})

import { describe, expect, it } from 'vitest'
import { planCommitMessageGeneration } from './commit-message-plan'

describe('Antigravity generation planning', () => {
  it.each(['-fix: something', '--sandbox', 'line one\n"quoted"\r\n日本語 🐳'])(
    'keeps Antigravity prompt text out of argv: %s',
    (prompt) => {
      const result = planCommitMessageGeneration(
        { agentId: 'antigravity', model: 'default' },
        prompt
      )
      expect(result.ok).toBe(true)
      if (!result.ok) {
        throw new Error(result.error)
      }
      expect(result.plan.args).toEqual([
        '--print=',
        '--input-format=stream-json',
        '--output-format=stream-json',
        '--sandbox'
      ])
      expect(JSON.parse(result.plan.stdinPayload ?? '')).toEqual({
        event: 'user',
        message: { role: 'user', content: [{ type: 'text', text: prompt }] }
      })
    }
  )

  it('sends a large Antigravity prompt intact over stdin while leaving other argv agents alone', () => {
    const bigPrompt = 'y'.repeat(200_000)
    const result = planCommitMessageGeneration(
      { agentId: 'antigravity', model: 'default' },
      bigPrompt
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error(result.error)
    }
    expect(result.plan.args.join(' ').length).toBeLessThan(100)
    expect(JSON.parse(result.plan.stdinPayload ?? '').message.content[0].text).toBe(bigPrompt)

    const cursorResult = planCommitMessageGeneration(
      { agentId: 'cursor', model: 'auto' },
      bigPrompt
    )
    expect(cursorResult.ok).toBe(true)
    expect(cursorResult.ok && cursorResult.plan.args.at(-1)).toBe(bigPrompt)
    expect(cursorResult.ok && cursorResult.plan.stdinPayload).toBeNull()
  })

  for (const source of ['recipe', 'command prefix']) {
    it.each([
      '--input-format=text --output-format=text',
      '--input-format text --output-format json',
      '-input-format=text --output-format json -output-format=text',
      '--input-format text --input-format=stream-json --output-format=json --output-format text'
    ])(`keeps stream transport when ${source} overrides formats: %s`, (formats) => {
      const result = planCommitMessageGeneration(
        {
          agentId: 'antigravity',
          model: 'default',
          agentCommandOverride: source === 'command prefix' ? `agy ${formats}` : undefined,
          agentArgs: `${source === 'recipe' ? formats : ''} --add-dir . --effort low`
        },
        'Generate a pull request'
      )
      expect(result.ok).toBe(true)
      if (!result.ok) {
        throw new Error(result.error)
      }
      expect(result.plan.args).toEqual([
        '--print=',
        '--input-format=stream-json',
        '--output-format=stream-json',
        '--sandbox',
        '--add-dir',
        '.',
        '--effort',
        'low'
      ])
      expect(result.plan.outputFormat).toBe('antigravity-stream-json')
      expect(JSON.parse(result.plan.stdinPayload ?? '').message.content[0].text).toBe(
        'Generate a pull request'
      )
    })
  }

  // #14059 recipe: preserve extra CLI args outside print’s operand while deduping repeated model flags regardless of argument order.
  it('keeps #14059-style recipe CLI arguments intact and deduped around the print operand', () => {
    const result = planCommitMessageGeneration(
      {
        agentId: 'antigravity',
        model: 'Gemini 3.5 Flash (Medium)',
        agentArgs:
          '--add-dir . --model gemini-3.6-flash --effort low --dangerously-skip-permissions'
      },
      'Generate a concise git commit message for the currently staged changes.'
    )

    expect(result).toEqual({
      ok: true,
      plan: {
        binary: 'agy',
        args: [
          '--print=',
          '--input-format=stream-json',
          '--output-format=stream-json',
          '--sandbox',
          '--model',
          'gemini-3.6-flash',
          '--add-dir',
          '.',
          '--effort',
          'low',
          '--dangerously-skip-permissions'
        ],
        stdinPayload: `${JSON.stringify({
          event: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Generate a concise git commit message for the currently staged changes.'
              }
            ]
          }
        })}\n`,
        label: 'Antigravity',
        outputFormat: 'antigravity-stream-json'
      }
    })
  })
})

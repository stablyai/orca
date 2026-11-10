import { writeFile, appendFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { dir, kill, pane, drain, prompt, stamp } from './claude-helper-kill.test-fixture'

describe('Claude helper provider evidence', () => {
  it.each([false, true])(
    'ignores mixed server-result echoes after a kill; real prompt: %s',
    async (realPrompt) => {
      const p = await pane()
      try {
        await writeFile(p.child('a123'), prompt(1))
        await appendFile(p.path, kill(2))
        await appendFile(
          p.child('a123'),
          `${JSON.stringify({
            type: 'user',
            timestamp: stamp(3),
            message: {
              role: 'user',
              content: [
                { type: 'text', text: 'server context' },
                {
                  type: 'advisor_tool_result',
                  tool_use_id: 'server',
                  content: { type: 'advisor_redacted_result' }
                }
              ]
            }
          })}\n`
        )
        if (realPrompt) {
          await appendFile(p.child('a123'), prompt(4))
        }
        await drain(p)
        if (realPrompt) {
          expect(p.row().payload.subagents?.[0]?.state).toBe('working')
        } else {
          expect(p.row().payload.subagents ?? []).toEqual([])
        }
      } finally {
        p.poller.clearAll()
      }
    }
  )

  it('forgets kills on parent file replacement', async () => {
    const p = await pane()
    try {
      await appendFile(p.path, kill())
      await drain(p)
      expect(p.row().payload.subagents ?? []).toEqual([])
      await writeFile(join(dir, 'replacement.jsonl'), kill())
      await rename(join(dir, 'replacement.jsonl'), p.path)
      p.replace(p.post({ hook_event_name: 'SubagentStart', agent_id: 'a123' }))
      await drain(p)
      expect(p.row().payload.subagents?.[0]?.state).toBe('working')
    } finally {
      p.poller.clearAll()
    }
  })

  it('does not apply an in-flight read after pane retirement or to its successor', async () => {
    const p = await pane()
    try {
      await appendFile(p.path, kill())
      const reading = p.poller.poll('test-tab:11111111-1111-4111-8111-111111111111')
      p.poller.clear('test-tab:11111111-1111-4111-8111-111111111111')
      p.replace({
        ...p.row(),
        providerSession: { key: 'session_id', id: 'replacement', transcriptPath: p.path }
      })
      await reading
      expect(p.publish).not.toHaveBeenCalled()
    } finally {
      p.poller.clearAll()
    }
  })
})

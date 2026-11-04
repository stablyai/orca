import { writeFile, appendFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { dir, kill, pane, drain } from './claude-helper-kill.test-fixture'

describe('Claude helper provider evidence', () => {
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

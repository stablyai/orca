import { describe, expect, it } from 'vitest'
import { parseAgentBoardOps } from './parse-agent-board-ops'

describe('parseAgentBoardOps', () => {
  it('returns empty ops when no fence', () => {
    const r = parseAgentBoardOps('Just a normal reply about the sketch.')
    expect(r.ops).toEqual([])
    expect(r.proseWithoutFence).toContain('normal reply')
  })

  it('parses collab-board fence with geo + draft + note', () => {
    const reply = [
      'Here is a layout proposal:',
      '```collab-board',
      JSON.stringify([
        { op: 'geo', geo: 'rectangle', x: 10, y: 20, w: 200, h: 80, label: 'Login' },
        { op: 'note', x: 10, y: 120, text: 'Validate email' },
        { op: 'draft', body: 'Wire the submit handler next.' }
      ]),
      '```',
      'Done.'
    ].join('\n')
    const r = parseAgentBoardOps(reply)
    expect(r.ops).toHaveLength(3)
    expect(r.ops[0]).toMatchObject({ op: 'geo', geo: 'rectangle', label: 'Login' })
    expect(r.ops[1]).toMatchObject({ op: 'note', text: 'Validate email' })
    expect(r.ops[2]).toMatchObject({ op: 'draft', body: 'Wire the submit handler next.' })
    expect(r.proseWithoutFence).toContain('layout proposal')
    expect(r.proseWithoutFence).not.toContain('```')
  })

  it('drops invalid geo types', () => {
    const reply = '```collab-board\n[{"op":"geo","geo":"spaceship","x":0,"y":0,"w":10,"h":10}]\n```'
    expect(parseAgentBoardOps(reply).ops).toEqual([])
  })
})

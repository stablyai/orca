import { describe, expect, it } from 'vitest'
import { BOT_GROUP_TAB_FACE, botGroupFaces, botGroupTabFaces } from './bot-group-face-layout'

const faces = (members: string[]) =>
  botGroupFaces(members, (m) => m).map((f) =>
    'member' in f.face ? f.face.member : `+${f.face.more}`
  )

describe('botGroupFaces', () => {
  it('shows every member up to three, back to front', () => {
    expect(faces(['a', 'b'])).toEqual(['b', 'a'])
    expect(faces(['a', 'b', 'c'])).toEqual(['b', 'a', 'c'])
  })

  it('shows two faces and a "+N" circle the size of a face past three', () => {
    expect(faces(['a', 'b', 'c', 'd'])).toEqual(['b', 'a', '+2'])
    expect(faces(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'])).toEqual(['b', 'a', '+6'])
    const [, , more] = botGroupFaces(['a', 'b', 'c', 'd'], (m) => m)
    const [, , third] = botGroupFaces(['a', 'b', 'c'], (m) => m)
    expect([more!.x, more!.y, more!.size]).toEqual([third!.x, third!.y, third!.size])
  })

  it('stays inside the slot', () => {
    for (const n of [1, 2, 3, 4, 8]) {
      for (const f of botGroupFaces(
        Array.from({ length: n }, (_, i) => String(i)),
        (m) => m
      )) {
        expect(f.x + f.size).toBeLessThanOrEqual(28)
        expect(f.y + f.size).toBeLessThanOrEqual(28)
      }
    }
  })
})

describe('botGroupTabFaces', () => {
  const tab = (members: string[]) =>
    botGroupTabFaces(members, (m) => m).map((f) => ('member' in f.face ? f.face.member : null))

  it('draws the first two members side by side, the first in front', () => {
    expect(tab(['a'])).toEqual(['a'])
    expect(tab(['a', 'b'])).toEqual(['b', 'a'])
    expect(tab(['a', 'b', 'c', 'd'])).toEqual(['b', 'a'])
  })

  it("keeps faces at a bot tab avatar's size, overlapping by 4px", () => {
    const [back, front] = botGroupTabFaces(['a', 'b'], (m) => m)
    expect([front!.x, front!.size, back!.x, back!.size]).toEqual([
      0,
      BOT_GROUP_TAB_FACE,
      8,
      BOT_GROUP_TAB_FACE
    ])
  })
})

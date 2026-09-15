import { describe, expect, it } from 'vitest'
import {
  findActiveNativeChatRailItem,
  type NativeChatRailSlot
} from './native-chat-active-rail-item'

/** Rows 100px tall, laid end to end, as the virtualizer would report them. */
function rows(count: number, height = 100) {
  return Array.from({ length: count }, (_unused, index) => ({
    index,
    start: index * height,
    end: index * height + height
  }))
}

/** Turn shape: `u1` opens, three agent rows answer, `u2` opens the next. */
const TURNS: NativeChatRailSlot[] = [
  { turnKey: 'u1' },
  { turnKey: 'u1' },
  { turnKey: 'u1' },
  { turnKey: 'u1' },
  { turnKey: 'u2' },
  { turnKey: 'u2' },
  { turnKey: 'u2' },
  { turnKey: 'u2' },
  { turnKey: 'u2' },
  { turnKey: 'u2' }
]

const VIEWPORT = 300

/** Ten 100px rows against a 300px viewport, scrolled off the bottom. */
const MID_SCROLL = { clientHeight: VIEWPORT, scrollHeight: 1000, previousActiveId: null }

describe('active rail item', () => {
  // The whole point of resolving through `turnKey`: most of a transcript is reply,
  // and a rule that needs a user row on screen goes dark for the length of one.
  it('keeps the owning prompt lit while an agent reply fills the viewport', () => {
    expect(
      findActiveNativeChatRailItem({
        slots: TURNS,
        virtualItems: rows(10),
        scrollTop: 250,
        ...MID_SCROLL
      })
    ).toBe('u1')
  })

  it('moves to the next prompt once its turn reaches the fold', () => {
    expect(
      findActiveNativeChatRailItem({
        slots: TURNS,
        virtualItems: rows(10),
        scrollTop: 450,
        ...MID_SCROLL
      })
    ).toBe('u2')
  })

  it('selects the row the fold sits exactly on', () => {
    expect(
      findActiveNativeChatRailItem({
        slots: TURNS,
        virtualItems: rows(10),
        scrollTop: 400,
        ...MID_SCROLL
      })
    ).toBe('u2')
  })

  // A short last turn would otherwise light its predecessor while the reader is
  // staring at the newest prompt.
  it('lights the newest turn when pinned to the bottom', () => {
    expect(
      findActiveNativeChatRailItem({
        slots: TURNS,
        virtualItems: rows(10),
        scrollTop: 700,
        clientHeight: VIEWPORT,
        scrollHeight: 1000,
        previousActiveId: null
      })
    ).toBe('u2')
  })

  it('lights nothing above the first prompt', () => {
    expect(
      findActiveNativeChatRailItem({
        slots: [{ turnKey: undefined }, { turnKey: undefined }, ...TURNS],
        virtualItems: rows(12),
        scrollTop: 50,
        clientHeight: VIEWPORT,
        scrollHeight: 1200,
        previousActiveId: null
      })
    ).toBeNull()
  })

  // The window reflects the last committed render, so it can lag a scroll by a
  // commit. Holding the previous tick beats blanking one.
  it('holds the previous tick when the window is stale', () => {
    expect(
      findActiveNativeChatRailItem({
        slots: TURNS,
        virtualItems: [{ index: 0, start: 0, end: 100 }],
        scrollTop: 600,
        clientHeight: VIEWPORT,
        scrollHeight: 4000,
        previousActiveId: 'u1'
      })
    ).toBe('u1')
  })

  it('holds the previous tick when nothing is windowed', () => {
    expect(
      findActiveNativeChatRailItem({
        slots: TURNS,
        virtualItems: [],
        scrollTop: 0,
        clientHeight: VIEWPORT,
        scrollHeight: 1000,
        previousActiveId: 'u2'
      })
    ).toBe('u2')
  })

  it('keeps a row taller than the viewport active while it spans it', () => {
    expect(
      findActiveNativeChatRailItem({
        slots: [{ turnKey: 'u1' }],
        virtualItems: [{ index: 0, start: 0, end: 2000 }],
        scrollTop: 800,
        clientHeight: VIEWPORT,
        scrollHeight: 4000,
        previousActiveId: null
      })
    ).toBe('u1')
  })

  // `start` already carries `scrollMargin`, so subtracting it again would shift
  // every row and select the wrong turn.
  it('reads offsets in container space, margin included', () => {
    const margin = 500
    expect(
      findActiveNativeChatRailItem({
        slots: TURNS,
        virtualItems: rows(10).map((row) => ({
          ...row,
          start: row.start + margin,
          end: row.end + margin
        })),
        scrollTop: margin + 450,
        clientHeight: VIEWPORT,
        scrollHeight: 1500,
        previousActiveId: null
      })
    ).toBe('u2')
  })
})

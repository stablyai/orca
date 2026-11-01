import { describe, expect, it } from 'vitest'
import {
  findActiveNativeChatRailItem,
  type NativeChatRailSlot
} from './native-chat-active-rail-item'

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

const TICKS = [
  { id: 'u1', slotIndex: 0 },
  { id: 'u2', slotIndex: 4 }
]

const VIEWPORT = 300
/** Ten 100px rows against a 300px viewport, scrolled off the bottom. */
const MID_SCROLL = {
  clientHeight: VIEWPORT,
  scrollHeight: 1000,
  previousActiveId: null
}

describe('active rail item', () => {
  it('keeps the owning prompt lit while an agent reply fills the viewport', () => {
    expect(
      findActiveNativeChatRailItem({
        slots: TURNS,
        ticks: TICKS,
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
        ticks: TICKS,
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
        ticks: TICKS,
        virtualItems: rows(10),
        scrollTop: 400,
        ...MID_SCROLL
      })
    ).toBe('u2')
  })

  it('lights the newest turn when pinned to the bottom', () => {
    expect(
      findActiveNativeChatRailItem({
        slots: TURNS,
        ticks: TICKS,
        virtualItems: rows(10),
        scrollTop: 700,
        clientHeight: VIEWPORT,
        scrollHeight: 1000,
        previousActiveId: null
      })
    ).toBe('u2')
  })

  it('lights the turn at the fold when parked just above the bottom', () => {
    expect(
      findActiveNativeChatRailItem({
        slots: [{ turnKey: 'u1' }, { turnKey: 'u1' }, { turnKey: 'u2' }, { turnKey: 'u2' }],
        ticks: [
          { id: 'u1', slotIndex: 0 },
          { id: 'u2', slotIndex: 2 }
        ],
        virtualItems: rows(4),
        // 30px short of the end, with a `u1` row at the top edge.
        scrollTop: 100,
        clientHeight: VIEWPORT,
        scrollHeight: 430,
        previousActiveId: null
      })
    ).toBe('u1')
  })

  it('lights nothing above the first prompt', () => {
    expect(
      findActiveNativeChatRailItem({
        slots: [{ turnKey: undefined }, { turnKey: undefined }, ...TURNS],
        ticks: [
          { id: 'u1', slotIndex: 2 },
          { id: 'u2', slotIndex: 6 }
        ],
        virtualItems: rows(12),
        scrollTop: 50,
        clientHeight: VIEWPORT,
        scrollHeight: 1200,
        previousActiveId: null
      })
    ).toBeNull()
  })

  // Virtual items can lag by a commit; retain the previous tick rather than blanking it.
  it('holds the previous tick when the window is stale', () => {
    expect(
      findActiveNativeChatRailItem({
        slots: TURNS,
        ticks: TICKS,
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
        ticks: TICKS,
        virtualItems: [],
        scrollTop: 0,
        clientHeight: VIEWPORT,
        scrollHeight: 1000,
        previousActiveId: 'u2'
      })
    ).toBe('u2')
  })

  it('lights a prompt in no turn by its own tick', () => {
    const slots: NativeChatRailSlot[] = [...TURNS, { turnKey: undefined }]
    const ticks = [...TICKS, { id: 'rejected', slotIndex: 10 }]
    expect(
      findActiveNativeChatRailItem({
        slots,
        ticks,
        virtualItems: rows(11),
        scrollTop: 800,
        clientHeight: VIEWPORT,
        scrollHeight: 1100,
        previousActiveId: null
      })
    ).toBe('rejected')
    expect(
      findActiveNativeChatRailItem({
        slots,
        ticks,
        virtualItems: rows(11),
        scrollTop: 1010,
        ...MID_SCROLL,
        scrollHeight: 2000
      })
    ).toBe('rejected')
  })

  // A message sent mid-turn takes the running turn's key but has its own tick.
  describe('a message sent into a running turn', () => {
    const slots: NativeChatRailSlot[] = [
      { turnKey: 'u1' },
      { turnKey: 'u1' },
      { turnKey: 'u1' },
      { turnKey: 'u1' },
      { turnKey: 'u1' }
    ]
    const ticks = [
      { id: 'u1', slotIndex: 0 },
      { id: 'steer', slotIndex: 2 }
    ]

    it('lights it when pinned to the bottom', () => {
      expect(
        findActiveNativeChatRailItem({
          slots,
          ticks,
          virtualItems: rows(5),
          scrollTop: 200,
          clientHeight: VIEWPORT,
          scrollHeight: 500,
          previousActiveId: null
        })
      ).toBe('steer')
    })

    it('lights the opener above it and itself from its row on', () => {
      const scroll = { slots, ticks, virtualItems: rows(5), ...MID_SCROLL }
      expect(findActiveNativeChatRailItem({ ...scroll, scrollTop: 150 })).toBe('u1')
      expect(findActiveNativeChatRailItem({ ...scroll, scrollTop: 250 })).toBe('steer')
    })

    it('stays lit past a row of no turn below it', () => {
      expect(
        findActiveNativeChatRailItem({
          slots: [...slots.slice(0, 3), { turnKey: undefined }, { turnKey: 'u1' }],
          ticks,
          virtualItems: rows(5),
          scrollTop: 450,
          ...MID_SCROLL
        })
      ).toBe('steer')
    })

    it('lights the outline prompt above the first loaded tick, and the tick below it', () => {
      const window = { slots, ticks: [{ id: 'steer', slotIndex: 2 }], virtualItems: rows(5) }
      expect(findActiveNativeChatRailItem({ ...window, scrollTop: 150, ...MID_SCROLL })).toBe('u1')
      expect(findActiveNativeChatRailItem({ ...window, scrollTop: 250, ...MID_SCROLL })).toBe(
        'steer'
      )
    })
  })

  it('lights the prompt above a turn the agent opened on its own', () => {
    expect(
      findActiveNativeChatRailItem({
        slots: [...TURNS, { turnKey: 'agent-turn' }, { turnKey: 'agent-turn' }],
        ticks: TICKS,
        virtualItems: rows(12),
        scrollTop: 1050,
        ...MID_SCROLL,
        scrollHeight: 2000
      })
    ).toBe('u2')
  })
})

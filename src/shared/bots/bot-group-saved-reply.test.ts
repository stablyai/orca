import { describe, expect, it } from 'vitest'
import { BOT_GROUP_SAVED_REPLY_MAX, botGroupSavedReplyMessages } from './bot-group'

const textOf = (reply: string | null, answer?: string) =>
  botGroupSavedReplyMessages({ operationId: 'op', reply, answer }).map((message) =>
    message.blocks.map((block) => (block.type === 'text' ? block.text : '')).join('')
  )

describe("a finished turn's saved reply in the room", () => {
  it('draws a short reply as one message', () => {
    expect(textOf('Shipped it.')).toEqual(['Shipped it.'])
  })

  it('draws nothing for a turn that ended without words', () => {
    expect(textOf(null)).toEqual([])
    expect(textOf('  \n ')).toEqual([])
    expect(textOf('NO_REPLY')).toEqual([])
  })

  it("closes with its answer to a member's request, and draws an answer alone", () => {
    expect(textOf('Checked.', 'Result: 42')).toEqual(['Checked.\n\nResult: 42'])
    expect(textOf(null, 'Result: 42')).toEqual(['Result: 42'])
  })

  it('starts a reply cut at the save cap on its next whole line', () => {
    const cut = `rtial line\n${'b'.repeat(BOT_GROUP_SAVED_REPLY_MAX - 11)}`
    expect(cut).toHaveLength(BOT_GROUP_SAVED_REPLY_MAX)
    expect(textOf(cut)).toEqual([`…\n\n${'b'.repeat(BOT_GROUP_SAVED_REPLY_MAX - 11)}`])
  })

  it('reopens a code block the cut began inside', () => {
    const tail = 'const b = 2\n```\n\nDone, with **bold** prose.'
    const cut = `${'x'.repeat(BOT_GROUP_SAVED_REPLY_MAX - tail.length - 1)}\n${tail}`
    expect(textOf(cut)).toEqual([`…\n\n\`\`\`\n${tail}`])
  })

  it('keeps whole code blocks after the cut as they are', () => {
    const tail = 'Intro\n~~~sh\nls\n~~~\nDone.'
    const cut = `${'x'.repeat(BOT_GROUP_SAVED_REPLY_MAX - tail.length - 1)}\n${tail}`
    expect(textOf(cut)).toEqual([`…\n\n${tail}`])
  })
})

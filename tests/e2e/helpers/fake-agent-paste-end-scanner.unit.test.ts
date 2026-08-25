import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import {
  FAKE_AGENT_PASTE_END_SCANNER_SOURCE,
  scanFakeAgentPasteEnd
} from './fake-agent-paste-end-scanner'

const PASTE_END = '\x1b[201~'

describe('scanFakeAgentPasteEnd', () => {
  it.each(Array.from({ length: PASTE_END.length - 1 }, (_, index) => index + 1))(
    'recognizes a paste terminator split after byte %i',
    (splitAt) => {
      const first = scanFakeAgentPasteEnd('', PASTE_END.slice(0, splitAt))
      const second = scanFakeAgentPasteEnd(first.tail, PASTE_END.slice(splitAt))

      expect(first.pasteBeginOffset).toBeNull()
      expect(first.pasteEndOffset).toBeNull()
      expect(second.pasteBeginOffset).toBeNull()
      expect(second.pasteEndOffset).toBe(PASTE_END.length - splitAt)
    }
  )

  it('keeps only the possible marker prefix between chunks', () => {
    const scan = scanFakeAgentPasteEnd('', `worker prompt${PASTE_END.slice(0, -1)}`)

    expect(scan).toEqual({
      tail: PASTE_END.slice(0, -1),
      pasteBeginOffset: null,
      pasteEndOffset: null
    })
  })

  it('emits standalone JavaScript for the fake agent process', () => {
    const context = vm.createContext({ result: null })
    vm.runInContext(
      `${FAKE_AGENT_PASTE_END_SCANNER_SOURCE}
       const first = scanFakeAgentPasteEnd('', '\x1b[20')
       result = scanFakeAgentPasteEnd(first.tail, '1~')`,
      context
    )

    expect(context.result).toEqual({
      tail: PASTE_END.slice(1),
      pasteBeginOffset: null,
      pasteEndOffset: 2
    })
  })

  it('recognizes a paste frame and submit delivered in separate chunks', () => {
    const context = vm.createContext({ result: null })
    vm.runInContext(
      `${FAKE_AGENT_PASTE_END_SCANNER_SOURCE}
       const modes = []
       fakeAgentMaybeAck({ pasteBeginOffset: 1, pasteEndOffset: null }, '', (mode) => modes.push(mode))
       fakeAgentMaybeAck({ pasteBeginOffset: null, pasteEndOffset: 1 }, '', (mode) => modes.push(mode))
       fakeAgentMaybeAck({ pasteBeginOffset: null, pasteEndOffset: null }, '\\r', (mode) => modes.push(mode))
       result = modes`,
      context
    )

    expect(context.result).toEqual(['bracketed'])
  })

  it('does not upgrade a paste frame received after submit', () => {
    const timers: (() => void)[] = []
    const context = vm.createContext({
      result: null,
      setTimeout: (fn: () => void) => timers.push(fn)
    })
    vm.runInContext(
      `${FAKE_AGENT_PASTE_END_SCANNER_SOURCE}
       const modes = []
       fakeAgentMaybeAck({ pasteBeginOffset: null, pasteEndOffset: null }, '\\r', (mode) => modes.push(mode))
       fakeAgentMaybeAck({ pasteBeginOffset: 1, pasteEndOffset: null }, '', (mode) => modes.push(mode))
       fakeAgentMaybeAck({ pasteBeginOffset: null, pasteEndOffset: 1 }, '', (mode) => modes.push(mode))
       result = modes`,
      context
    )
    expect(context.result).toEqual([])
    timers.forEach((timer) => timer())

    expect(vm.runInContext('modes', context)).toEqual(['unbracketed'])
  })

  it('ignores multiline carriage returns inside one bracketed paste chunk', () => {
    const context = vm.createContext({ result: null })
    vm.runInContext(
      `${FAKE_AGENT_PASTE_END_SCANNER_SOURCE}
       const modes = []
       const input = '\\x1b[200~line one\\rline two\\x1b[201~\\r'
       const scan = scanFakeAgentPasteEnd('', input)
       fakeAgentMaybeAck(scan, input, (mode) => modes.push(mode))
       result = modes`,
      context
    )

    expect(context.result).toEqual(['bracketed'])
  })

  it('ignores multiline carriage returns across bracketed paste chunks', () => {
    const context = vm.createContext({ result: null })
    vm.runInContext(
      `${FAKE_AGENT_PASTE_END_SCANNER_SOURCE}
       const modes = []
       for (const input of ['\\x1b[200~line one', '\\rline two', '\\x1b[201~', '\\r']) {
         const scan = scanFakeAgentPasteEnd(fakeAgentPasteEndTail, input)
         fakeAgentPasteEndTail = scan.tail
         fakeAgentMaybeAck(scan, input, (mode) => modes.push(mode))
       }
       result = modes`,
      context
    )

    expect(context.result).toEqual(['bracketed'])
  })
})

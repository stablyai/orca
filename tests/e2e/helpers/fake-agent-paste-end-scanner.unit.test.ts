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

      expect(first.ended).toBe(false)
      expect(second.ended).toBe(true)
    }
  )

  it('keeps only the possible marker prefix between chunks', () => {
    const scan = scanFakeAgentPasteEnd('', `worker prompt${PASTE_END.slice(0, -1)}`)

    expect(scan).toEqual({ tail: PASTE_END.slice(0, -1), ended: false })
  })

  it('emits standalone JavaScript for the fake agent process', () => {
    const context = vm.createContext({ result: null })
    vm.runInContext(
      `${FAKE_AGENT_PASTE_END_SCANNER_SOURCE}
       const first = scanFakeAgentPasteEnd('', '\\x1b[20')
       result = scanFakeAgentPasteEnd(first.tail, '1~')`,
      context
    )

    expect(context.result).toEqual({ tail: PASTE_END.slice(1), ended: true })
  })
})

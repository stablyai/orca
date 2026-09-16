import { describe, expect, it, vi } from 'vitest'
import { createAgentStatusOscProcessor } from './agent-status-osc'

function parseWithSearchBudget(data: string) {
  let searchedChars = 0
  const indexOf = String.prototype.indexOf
  const charCodeAt = String.prototype.charCodeAt
  const exec = RegExp.prototype.exec
  const indexOfSpy = vi.spyOn(String.prototype, 'indexOf').mockImplementation(function (
    this: string,
    search,
    from = 0
  ) {
    const found = indexOf.call(this, search, from)
    if (this === data) {
      searchedChars += (found === -1 ? data.length : found + search.length) - from
    }
    return found
  })
  const execSpy = vi
    .spyOn(RegExp.prototype, 'exec')
    .mockImplementation(function (this: RegExp, input) {
      const from = this.global || this.sticky ? this.lastIndex : 0
      const found = exec.call(this, input)
      if (input === data) {
        searchedChars += (found === null ? data.length : found.index + found[0].length) - from
      }
      return found
    })
  const charCodeAtSpy = vi
    .spyOn(String.prototype, 'charCodeAt')
    .mockImplementation(function (this: string, index) {
      if (this === data) {
        searchedChars += 1
      }
      return charCodeAt.call(this, index)
    })
  try {
    return { result: createAgentStatusOscProcessor()(data), searchedChars }
  } finally {
    indexOfSpy.mockRestore()
    execSpy.mockRestore()
    charCodeAtSpy.mockRestore()
  }
}

describe('OSC 9999 scan budget', () => {
  it.each(['\x07', '\x1b\\'])('reads each burst only forward with terminator %j', (terminator) => {
    const count = 5000
    const statuses = Array.from({ length: count }, (_, index) => ({
      state: index % 2 === 0 ? 'working' : 'done',
      prompt: `turn ${index}`
    }))
    const data = statuses
      .map((status) => `log\x1b]9999;${JSON.stringify(status)}${terminator}`)
      .join('')

    const { result, searchedChars } = parseWithSearchBudget(data)

    expect(result).toEqual({
      cleanData: 'log'.repeat(count),
      payloads: statuses,
      lastPayloadCleanOffset: count * 3
    })
    expect(searchedChars).toBeLessThanOrEqual(data.length * 2)
  })

  it('keeps a one-character input echo on the ordinary-output path', () => {
    const { result, searchedChars } = parseWithSearchBudget('a')

    expect(result).toEqual({ cleanData: 'a', payloads: [], lastPayloadCleanOffset: null })
    expect(searchedChars).toBe(1)
  })

  it('does not retain the output chunk in legacy regular-expression state', () => {
    const data = `\x1b]9999;{"state":"working"}\x07${'output'.repeat(200_000)}`
    void /reset/.test('reset')

    createAgentStatusOscProcessor()(data)
    const retainedInput = RegExp.input

    expect(retainedInput).not.toBe(data)
  })
})

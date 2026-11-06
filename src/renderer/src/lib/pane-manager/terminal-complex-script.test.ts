import { expect, it, vi } from 'vitest'
import { terminalOutputPrefersRenderRefresh } from './terminal-complex-script'

it.each(['\x1b[32mx\x1b[0m', '\x1b[38m'])(
  'keeps parameter scanning linear for repeated simple SGR %j',
  (sequence) => {
    for (const repetitions of [1_000, 10_000]) {
      const data = sequence.repeat(repetitions)
      let examinedCharacters = 0
      const indexOf = String.prototype.indexOf
      const charCodeAt = String.prototype.charCodeAt
      const indexOfSpy = vi.spyOn(String.prototype, 'indexOf').mockImplementation(function (
        this: string,
        search,
        position = 0
      ) {
        const result = indexOf.call(this, search, position)
        if (String(this) === data) {
          examinedCharacters +=
            result < 0 ? this.length - position : result - position + search.length
        }
        return result
      })
      const charCodeAtSpy = vi.spyOn(String.prototype, 'charCodeAt').mockImplementation(function (
        this: string,
        position
      ) {
        if (String(this) === data) {
          examinedCharacters += 1
        }
        return charCodeAt.call(this, position)
      })
      let prefersRefresh: boolean
      try {
        prefersRefresh = terminalOutputPrefersRenderRefresh(data)
      } finally {
        indexOfSpy.mockRestore()
        charCodeAtSpy.mockRestore()
      }
      expect(prefersRefresh).toBe(false)
      expect(examinedCharacters).toBeLessThan(data.length * 12)
    }
  }
)

it.each([
  ['\x1b[38;2;1;2;44m', false],
  ['\x1b[38;2;1;2;3;41m', true],
  ['\x1b[38:5:1;44m', true],
  ['\x1b[38;5;41m', false],
  ['\x1b[38;41m', false],
  ['\x1b[0041m', true],
  ['\x1b[4:41m', false],
  ['\x1b[48m', true],
  ['\x1b[\x1b[41m', true]
])('classifies background SGR parameters in %j as %s', (data, expected) => {
  expect(terminalOutputPrefersRenderRefresh(data)).toBe(expected)
})

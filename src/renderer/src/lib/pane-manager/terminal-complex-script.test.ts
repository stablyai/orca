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

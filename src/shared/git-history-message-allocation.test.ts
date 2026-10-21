import { expect, it, vi } from 'vitest'
import { parseGitHistoryLog } from './git-history-log-parser'

it('keeps a multiline commit body intact without materializing every message line', () => {
  const message = `subject\n\n${'body line\n'.repeat(10000)}`
  const record = [
    'a'.repeat(40),
    'Author',
    'email',
    '1700000000',
    '1700000000',
    '',
    '',
    '',
    message
  ].join('\n')
  // Method-shaped type: a call-signature capture would reject `split`'s splitter-object overload.
  const original: { split(separator: unknown, limit?: number): string[] }['split'] =
    String.prototype.split
  let allocatedFields = 0
  const spy = vi.spyOn(String.prototype, 'split').mockImplementation(function (
    this: string,
    separator: unknown,
    limit?: number
  ) {
    const result = original.call(this, separator, limit)
    if (separator === '\n' && String(this).includes('body line')) {
      allocatedFields += result.length
    }
    return result
  })
  let result: ReturnType<typeof parseGitHistoryLog>
  try {
    result = parseGitHistoryLog(`${record}\n\0`)
  } finally {
    spy.mockRestore()
  }
  expect(result![0].message).toBe(message)
  expect(result![0].subject).toBe('subject')
  expect(allocatedFields).toBe(0)
})

it('preserves incomplete header and empty body behavior', () => {
  for (const suffix of ['', '\nAuthor', '\nAuthor\nemail\n0\n0\n\n\n']) {
    expect(parseGitHistoryLog(`${'a'.repeat(40)}${suffix}\0`)[0].message).toBe('')
  }
})

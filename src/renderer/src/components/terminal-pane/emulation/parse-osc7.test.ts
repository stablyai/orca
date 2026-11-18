import { expect, it } from 'vitest'
import { parseOsc7 } from './parse-osc7'

it('keeps the server already carried in a UNC pathname when the launch host matches', () => {
  expect(
    parseOsc7('file://localhost//localhost/share/sub%20%C3%A9%2541%23', { uncHost: 'localhost' })
  ).toBe('//localhost/share/sub é%41#')
})

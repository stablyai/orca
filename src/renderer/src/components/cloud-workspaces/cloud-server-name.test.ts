import { describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    fallback.replace('{{value0}}', values?.value0 ?? '')
}))

import { pickCloudServerName } from './cloud-server-name'

describe('the server name a cloud workspace is paired under', () => {
  it('a second workspace from the same repository gets its W-number instead of failing', () => {
    expect(pickCloudServerName('xterm.js', 715, [])).toBe('xterm.js (cloud)')
    expect(pickCloudServerName('xterm.js', 715, [{ name: 'xterm.js (cloud)' }])).toBe(
      'xterm.js W-715 (cloud)'
    )
    expect(
      pickCloudServerName('xterm.js', 715, [
        { name: 'XTERM.JS (cloud)' },
        { name: 'xterm.js W-715 (cloud)' }
      ])
    ).toBe('xterm.js W-715 2 (cloud)')
    expect(pickCloudServerName('xterm.js', null, [{ name: 'xterm.js (cloud)' }])).toBe(
      'xterm.js 2 (cloud)'
    )
  })
})

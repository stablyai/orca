import { describe, expect, it } from 'vitest'
import { classifyBoardsProxyStatus } from './boards-proxy-status-classification'
import { PLUGIN_TASK_SOURCE_ERROR_CODES } from '../plugins/plugin-task-source-contract'

describe('classifyBoardsProxyStatus', () => {
  it.each([
    [400, 'validation'],
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [409, 'conflict'],
    [412, 'not_configured'],
    [429, 'rate_limited']
  ] as const)('maps %i to %s', (status, code) => {
    expect(classifyBoardsProxyStatus(status)).toBe(code)
  })

  it.each([200, 201, 202, 204, 299])('treats %i as success', (status) => {
    expect(classifyBoardsProxyStatus(status)).toBeNull()
  })

  it.each([418, 300, 451, 500, 502, 503, 504])(
    'falls back to unavailable for unlisted status %i',
    (status) => {
      expect(classifyBoardsProxyStatus(status)).toBe('unavailable')
    }
  )

  it('only ever returns a code from the closed vocabulary', () => {
    for (let status = 100; status < 600; status += 1) {
      const code = classifyBoardsProxyStatus(status)
      expect(code === null || PLUGIN_TASK_SOURCE_ERROR_CODES.includes(code)).toBe(true)
    }
  })
})

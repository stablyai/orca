import { describe, expect, it } from 'vitest'
import { isPagerProcess } from './pager-process-detection'

describe('isPagerProcess', () => {
  it.each(['less', '/usr/bin/less', 'more', 'MORE.COM', 'most', '"less"'])(
    '%j is a pager',
    (name) => {
      expect(isPagerProcess(name)).toBe(true)
    }
  )

  it.each(['zsh', 'node', 'claude', 'claude-2.1.316', 'lesson', '', null, undefined])(
    '%j is not',
    (name) => {
      expect(isPagerProcess(name)).toBe(false)
    }
  )
})

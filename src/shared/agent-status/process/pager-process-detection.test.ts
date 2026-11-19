import { describe, expect, it } from 'vitest'
import { isPagerProcess } from './pager-process-detection'

describe('isPagerProcess', () => {
  it.each(['/usr/bin/less', 'MORE.COM', '"less"'])('%j is a pager', (name) => {
    expect(isPagerProcess(name)).toBe(true)
  })

  it.each(['lesson', '', null])('%j is not', (name) => {
    expect(isPagerProcess(name)).toBe(false)
  })
})

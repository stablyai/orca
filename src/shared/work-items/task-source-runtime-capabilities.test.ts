import { describe, expect, it } from 'vitest'
import { RUNTIME_CAPABILITIES } from '../protocol-version'

describe('task source runtime capabilities', () => {
  it('advertises Backlog.md support exactly once so clients gate paired runtimes on it', () => {
    expect(RUNTIME_CAPABILITIES.filter((value) => value === 'tasks.backlog.v1')).toHaveLength(1)
  })
})

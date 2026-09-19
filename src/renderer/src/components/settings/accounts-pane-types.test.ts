import { describe, expectTypeOf, it } from 'vitest'
import type { ClaudeAccountAction, CodexAccountAction } from './accounts-pane-types'

describe('ClaudeAccountAction', () => {
  it('adds a rename arm without widening CodexAccountAction', () => {
    expectTypeOf<ClaudeAccountAction>().toEqualTypeOf<CodexAccountAction | `rename:${string}`>()
    expectTypeOf<Extract<ClaudeAccountAction, `rename:${string}`>>().not.toBeNever()
    expectTypeOf<Extract<CodexAccountAction, `rename:${string}`>>().toBeNever()
  })
})

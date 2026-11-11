import { expect, it } from 'vitest'
import { shouldRenderCommitArea } from './component-gates'

it('keeps manual revert completion available until sequencer recovery is supported', () => {
  expect(shouldRenderCommitArea(0, 'revert', false)).toBe(true)
  expect(shouldRenderCommitArea(0, 'revert', true)).toBe(false)
  expect(shouldRenderCommitArea(1, 'revert', false)).toBe(false)
})

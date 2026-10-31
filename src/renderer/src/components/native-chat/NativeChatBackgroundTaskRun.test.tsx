// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup } from '@testing-library/react'

import { afterEach, describe, expect, it } from 'vitest'
import type { NativeChatBackgroundTaskBlock } from '../../../../shared/native-chat-types'
import { deriveNativeChatRowContent } from '../../../../shared/native-chat-row-content'

afterEach(cleanup)

function task(
  overrides: Partial<NativeChatBackgroundTaskBlock> = {}
): NativeChatBackgroundTaskBlock {
  return {
    type: 'background-task',
    taskId: 'byjnee2no',
    kind: 'command',
    label: 'Wait for the verification verdict',
    state: 'working',
    startedAt: 1_000,
    ...overrides
  }
}

describe('background task rows in a transcript message', () => {
  it('drops the frozen twin the block replaces, and keeps real prose', () => {
    const block = task({ state: 'blocked', summary: 'it failed' })
    const content = deriveNativeChatRowContent([
      { type: 'text', text: 'here is what happened' },
      { type: 'text', text: 'it failed' },
      block
    ])
    expect(content.markdown).toBe('here is what happened')
    expect(content.backgroundTasks).toEqual([block])
  })
})

import { expect, it } from 'vitest'
import { nativeChatPathBase } from './native-chat-path-base'

it.each([
  { launch: '/repo/pkg/app', expected: '/repo/pkg/app' },
  { launch: '/repo/', expected: null }
])(
  'resolves a chat’s relative paths from its sub-folder, not the workspace itself: %j',
  ({ launch, expected }) => {
    expect(nativeChatPathBase('/repo', launch)).toBe(expected)
  }
)

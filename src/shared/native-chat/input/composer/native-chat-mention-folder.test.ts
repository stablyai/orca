import { expect, it } from 'vitest'
import { mentionPathFromChatFolder } from './native-chat-mention-folder'

it.each([
  { path: 'pkg/app/src/x.ts', expected: 'src/x.ts' },
  { path: 'pkg/app/src/', expected: 'src/' },
  { path: 'pkg/app/', expected: './' },
  { path: 'README.md', expected: '../../README.md' },
  { path: 'pkg/application.ts', expected: '../application.ts' }
])('names a picked workspace file from a chat running in pkg/app: %j', ({ path, expected }) => {
  expect(mentionPathFromChatFolder(path, 'pkg/app')).toBe(expected)
})

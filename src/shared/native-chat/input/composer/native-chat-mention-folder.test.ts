import { expect, it } from 'vitest'
import { chatFolderFileReference, mentionPathFromChatFolder } from './native-chat-mention-folder'

it.each([
  { path: 'pkg/app/src/x.ts', expected: 'src/x.ts' },
  { path: 'pkg/app/src/', expected: 'src/' },
  { path: 'pkg/app/', expected: './' },
  { path: 'README.md', expected: '../../README.md' },
  { path: 'pkg/application.ts', expected: '../application.ts' }
])('names a picked workspace file from a chat running in pkg/app: %j', ({ path, expected }) => {
  expect(mentionPathFromChatFolder(path, 'pkg/app')).toBe(expected)
})

it.each([
  { workspace: '/repo', launch: '/repo/pkg/app', expected: '@src/x.ts' },
  // Windows hosts compare drive and case loosely, as their file systems do.
  { workspace: 'C:\\Repo', launch: 'c:\\repo\\pkg\\app', expected: '@src/x.ts' },
  { workspace: '/repo', launch: '/repo', expected: undefined },
  { workspace: '/repo', launch: '/elsewhere/pkg/app', expected: undefined }
])(
  'writes a pick from the folder the host runs the chat in: %j',
  ({ workspace, launch, expected }) => {
    expect(chatFolderFileReference('pkg/app/src/x.ts', workspace, launch)).toBe(expected)
  }
)

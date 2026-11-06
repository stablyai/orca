import { describe, expect, it } from 'vitest'

import { createNativeChatFileHref } from '../../../../shared/native-chat/native-chat-href-routing'
import { resolveNativeChatFileLink, type NativeChatFileLinkContext } from './native-chat-file-link'

const context: NativeChatFileLinkContext = {
  worktreeId: 'wt-1',
  worktreePath: '/repo/worktree',
  runtimeEnvironmentId: null
}

describe('resolveNativeChatFileLink', () => {
  it.each([
    ['/repo/report:12', '/repo/report:12'],
    ['/repo/report:0', '/repo/report:0'],
    ['/repo/report:12:4', '/repo/report:12:4'],
    ['/repo/ leading ', '/repo/ leading '],
    [' leading ', '/repo/worktree/ leading '],
    ['notes%23?#.md', '/repo/worktree/notes%23?#.md'],
    ['https:notes.md', '/repo/worktree/https:notes.md'],
    ['file:notes.md', '/repo/worktree/file:notes.md'],
    ['../sibling/readme.md', '/repo/sibling/readme.md']
  ])('resolves literal tool path %j without parsing a reply location', (path, absolutePath) => {
    expect(resolveNativeChatFileLink(createNativeChatFileHref(path, 'literal'), context)).toEqual({
      absolutePath,
      line: null,
      column: null
    })
  })

  it('reads URL-style /D:/ targets as the drive only in a Windows workspace', () => {
    const windowsContext = { ...context, worktreePath: 'D:/repo' }
    for (const href of ['/D:/Temp/report.txt', createNativeChatFileHref('/D:/Temp/report.txt')]) {
      expect(resolveNativeChatFileLink(href, windowsContext)?.absolutePath).toBe(
        'D:/Temp/report.txt'
      )
    }
    expect(
      resolveNativeChatFileLink(
        createNativeChatFileHref('/D:/Temp/report.txt', 'literal'),
        windowsContext
      )?.absolutePath
    ).toBe('D:/Temp/report.txt')
    expect(
      resolveNativeChatFileLink('//server/share/report.txt', windowsContext)?.absolutePath
    ).toBe('//server/share/report.txt')
    expect(resolveNativeChatFileLink('/D:/Temp/report.txt', context)?.absolutePath).toBe(
      '/D:/Temp/report.txt'
    )
  })
})

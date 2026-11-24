import { describe, expect, it } from 'vitest'
import { createNativeChatFileHref } from '../../../../../shared/native-chat/file-access/native-chat-href-routing'
import { botItemFileLinkName } from './bot-item-file-link-name'

describe('botItemFileLinkName', () => {
  it('shows a written-out path as its file name, on every platform', () => {
    const posix = '/Users/you/.orca/bots/ops/reviews/connector-global-stop-runbook.md'
    expect(botItemFileLinkName(createNativeChatFileHref(posix), posix)).toBe(
      'connector-global-stop-runbook.md'
    )
    const windows = 'C:\\Users\\you\\notes\\plan.md'
    expect(botItemFileLinkName(createNativeChatFileHref(windows), windows)).toBe('plan.md')
    expect(botItemFileLinkName('file:///tmp/a/b.ts', 'file:///tmp/a/b.ts')).toBe('b.ts')
    expect(botItemFileLinkName(createNativeChatFileHref('src/a.ts:12'), 'src/a.ts:12')).toBe(
      'a.ts:12'
    )
  })

  it('keeps words chosen for the link, bare names and web links', () => {
    expect(botItemFileLinkName(createNativeChatFileHref('/a/b.md'), 'the runbook')).toBeNull()
    expect(botItemFileLinkName('docs/deployment.md', 'CI/CD')).toBeNull()
    expect(botItemFileLinkName('docs/Deployment%20Plan.md', 'docs/Deployment Plan.md')).toBe(
      'Deployment Plan.md'
    )
    expect(botItemFileLinkName(createNativeChatFileHref('README.md'), 'README.md')).toBeNull()
    expect(
      botItemFileLinkName('https://example.com/a/b.html', 'https://example.com/a/b.html')
    ).toBeNull()
  })
})

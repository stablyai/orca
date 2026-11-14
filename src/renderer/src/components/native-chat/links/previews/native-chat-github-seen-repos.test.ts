import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import { linkGitHubReferences } from '../../../../../../shared/github/markdown/github-reference-links'
import { nativeChatGitHubSeenRepos } from './native-chat-github-seen-repos'

const chatRepo = { owner: 'acme', repo: 'service-a' }

function message(id: string, blocks: NativeChatMessage['blocks']): NativeChatMessage {
  return { id, role: 'assistant', blocks, timestamp: null, source: 'transcript' }
}

function linkedUrls(text: string, messages: readonly NativeChatMessage[]): string[] {
  const tree = {
    type: 'root',
    children: [{ type: 'paragraph', children: [{ type: 'text', value: text }] }]
  }
  linkGitHubReferences(tree, chatRepo, nativeChatGitHubSeenRepos(messages))
  return tree.children[0]!.children.flatMap((node: { type: string; url?: string }) =>
    node.type === 'link' && node.url ? [node.url] : []
  )
}

function command(script: string, output: string): NativeChatMessage['blocks'] {
  return [
    { type: 'tool-call', name: 'Bash', input: { command: script } },
    { type: 'tool-result', output }
  ]
}

describe('nativeChatGitHubSeenRepos', () => {
  it('links a bare #N to the github.com repo gh printed with that number', () => {
    const messages = [
      message(
        '1',
        command(
          'gh pr create --fill',
          'https://github.com/acme/service-b/pull/63\nhttps://ghe.example.com/acme/service-b/pull/7\n'
        )
      )
    ]

    expect(linkedUrls('I opened #63, #7 and other/repo#63.', messages)).toEqual([
      'https://github.com/acme/service-b/issues/63',
      'https://github.com/acme/service-a/issues/7',
      'https://github.com/other/repo/issues/63'
    ])
  })

  it('reads URLs that end a sentence and follows the latest one for a number', () => {
    const messages = [
      message('1', [
        { type: 'text', text: 'See https://github.com/acme/service-b/issues/21/files' }
      ]),
      message('2', [{ type: 'text', text: 'Charts wait for https://github.com/acme/ui/pull/21.' }])
    ]

    expect(linkedUrls('ui PR #21', messages)).toEqual(['https://github.com/acme/ui/issues/21'])
  })

  it('ignores URLs in output of commands other than gh', () => {
    const messages = [
      message('1', command('cat CHANGELOG.md', 'Fixed in https://github.com/acme/ui/pull/9\n')),
      message('2', [{ type: 'text', text: 'Fixed in https://github.com/acme/ui/pull/9' }])
    ]

    expect(linkedUrls('#9', [messages[0]!])).toEqual(['https://github.com/acme/service-a/issues/9'])
    expect(linkedUrls('#9', messages)).toEqual(['https://github.com/acme/ui/issues/9'])
  })

  it('follows the latest sighting in block order within one message', () => {
    const messages = [
      message('1', [
        ...command('gh pr view 21 --json url', 'https://github.com/acme/service-b/pull/21\n'),
        { type: 'text', text: 'Actually it is https://github.com/acme/ui/pull/21' }
      ])
    ]

    expect(linkedUrls('#21', messages)).toEqual(['https://github.com/acme/ui/issues/21'])
  })

  it('reads gh output after a comment, cd or a heredoc body, but not output mixed with other commands', () => {
    const created = command(
      '# open the PR\ncd ../ui && gh pr create --title x --body "$(cat <<\'EOF\'\nSee notes; cat a\nEOF\n)"',
      'https://github.com/acme/ui/pull/4\n'
    )
    const mixed = command(
      'gh --version && cat CHANGELOG.md',
      'gh version 2.0\nhttps://github.com/acme/ui/pull/5\n'
    )

    expect(linkedUrls('#4 #5', [message('1', created), message('2', mixed)])).toEqual([
      'https://github.com/acme/ui/issues/4',
      'https://github.com/acme/service-a/issues/5'
    ])
  })
})

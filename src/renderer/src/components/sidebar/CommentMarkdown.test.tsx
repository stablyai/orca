import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import CommentMarkdown, { remarkGitHubReferences } from './CommentMarkdown'

describe('CommentMarkdown', () => {
  it('autolinks same-repo GitHub issue references when repo context is provided', () => {
    const markup = renderToStaticMarkup(
      <CommentMarkdown
        variant="document"
        githubRepo={{ owner: 'stablyai', repo: 'orca' }}
        content="Automated fix-PR from pr-bug-scan for parent **#2316**."
      />
    )

    expect(markup).toContain('href="https://github.com/stablyai/orca/issues/2316"')
    expect(markup).toContain('<strong><a')
  })

  it('autolinks cross-repo GitHub issue references', () => {
    const markup = renderToStaticMarkup(
      <CommentMarkdown
        variant="document"
        githubRepo={{ owner: 'stablyai', repo: 'orca' }}
        content="See another-org/other-repo#42."
      />
    )

    expect(markup).toContain('href="https://github.com/another-org/other-repo/issues/42"')
  })

  it('does not autolink GitHub issue references inside existing links or code', () => {
    const markup = renderToStaticMarkup(
      <CommentMarkdown
        variant="document"
        githubRepo={{ owner: 'stablyai', repo: 'orca' }}
        content="[`#2316`](https://example.com/already-linked) and `#2317`"
      />
    )

    expect(markup).toContain('href="https://example.com/already-linked"')
    expect(markup).not.toContain('href="https://github.com/stablyai/orca/issues/2316"')
    expect(markup).not.toContain('href="https://github.com/stablyai/orca/issues/2317"')
  })

  it('autolinks very large generated GitHub reference comments', () => {
    const referenceCount = 130_000
    const tree = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            {
              type: 'text',
              value: Array.from({ length: referenceCount }, (_, index) => `#${index + 1}`).join(' ')
            }
          ]
        }
      ]
    }

    const transform = remarkGitHubReferences({ owner: 'stablyai', repo: 'orca' })()

    expect(() => transform(tree)).not.toThrow()
    expect(tree.children[0]?.children).toHaveLength(referenceCount * 2 - 1)
    expect(tree.children[0]?.children[0]).toMatchObject({
      type: 'link',
      url: 'https://github.com/stablyai/orca/issues/1'
    })
  })

  it('contains long PR body markdown inside its available width', () => {
    const markup = renderToStaticMarkup(
      <CommentMarkdown
        variant="document"
        content={[
          '`src/main/hooks.ts:289 getEffectiveHookScript with policy=shared-only returns yamlScript?.trim() only; localScript is ignored`',
          '',
          '```',
          'const veryLongLine = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";',
          '```'
        ].join('\n')}
      />
    )

    expect(markup).toContain('min-w-0')
    expect(markup).toContain('max-w-full')
    expect(markup).toContain('[overflow-wrap:anywhere]')
    expect(markup).toContain('overflow-x-auto')
  })
})

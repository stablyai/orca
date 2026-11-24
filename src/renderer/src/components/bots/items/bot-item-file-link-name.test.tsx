// @vitest-environment happy-dom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import CommentMarkdown from '@/components/comment-markdown/CommentMarkdown'
import {
  createNativeChatFileHref,
  routeNativeChatHref
} from '../../../../../shared/native-chat/file-access/native-chat-href-routing'
import { botItemFileLinkName } from './bot-item-file-link-name'
import { SHORT_FILE_LINKS } from './BotItemMarkdown'

afterEach(cleanup)

const nameOf = (href: string | undefined, text: string) => botItemFileLinkName(href, text)?.name

describe('botItemFileLinkName', () => {
  it('shows a written-out path as its file name, on every platform', () => {
    const posix = '/Users/you/.orca/bots/ops/reviews/connector-global-stop-runbook.md'
    expect(botItemFileLinkName(createNativeChatFileHref(posix), posix)).toEqual({
      name: 'connector-global-stop-runbook.md',
      path: posix
    })
    const windows = 'C:\\Users\\you\\notes\\plan.md'
    expect(nameOf(createNativeChatFileHref(windows), windows)).toBe('plan.md')
    expect(nameOf('file:///tmp/a/b.ts', 'file:///tmp/a/b.ts')).toBe('b.ts')
    expect(nameOf(createNativeChatFileHref('src/a.ts:12'), 'src/a.ts:12')).toBe('a.ts:12')
  })

  it('keeps words chosen for the link, bare names and web links', () => {
    expect(botItemFileLinkName(createNativeChatFileHref('/a/b.md'), 'the runbook')).toBeNull()
    expect(botItemFileLinkName(createNativeChatFileHref('/a/b.md'), '/a/c.md')).toBeNull()
    expect(botItemFileLinkName('docs/deployment.md', 'CI/CD')).toBeNull()
    expect(nameOf('docs/Deployment%20Plan.md', 'docs/Deployment Plan.md')).toBe(
      'Deployment Plan.md'
    )
    expect(botItemFileLinkName(createNativeChatFileHref('README.md'), 'README.md')).toBeNull()
    expect(
      botItemFileLinkName('https://example.com/a/b.html', 'https://example.com/a/b.html')
    ).toBeNull()
  })
})

/** A description as the item page renders it: the real path detector, then the short-link anchor. */
function renderDescription(content: string): HTMLAnchorElement[] {
  const { container } = render(
    <CommentMarkdown
      content={content}
      onLinkClick={vi.fn()}
      allowFileUriLinks
      fileLinkExists={() => true}
      extension={SHORT_FILE_LINKS}
    />
  )
  return Array.from(container.querySelectorAll('a'))
}

function destination(anchor: HTMLAnchorElement): string | null {
  const route = routeNativeChatHref(anchor.getAttribute('href'))
  return route.kind === 'file' ? route.pathText : null
}

describe('description file links after the Markdown transform', () => {
  it.each([
    ['prose', 'See /tmp/work/notes/plan.md for the plan.'],
    ['inline code', 'See `/tmp/work/notes/plan.md` for the plan.']
  ])('shows a raw path in %s as its file name, the path on hover', (_, content) => {
    const [anchor] = renderDescription(content)
    expect(anchor.textContent).toBe('plan.md')
    expect(anchor.title).toBe('/tmp/work/notes/plan.md')
    expect(destination(anchor)).toBe('/tmp/work/notes/plan.md')
  })

  it.each([
    ['prose', 'Open file:///tmp/work/notes/plan.md now.'],
    ['inline code', 'Open `file:///tmp/work/notes/plan.md` now.']
  ])('shows a file URI in %s as its file name', (_, content) => {
    const [anchor] = renderDescription(content)
    expect(anchor.textContent).toBe('plan.md')
    expect(anchor.title).toBe('/tmp/work/notes/plan.md')
    expect(destination(anchor)).toBe('/tmp/work/notes/plan.md')
  })

  it.each([
    ['prose', 'Broken at /tmp/work/src/app.ts:003:02 today.'],
    ['inline code', 'Broken at `/tmp/work/src/app.ts:003:02` today.']
  ])('shows a padded location in %s with its file name and keeps the location', (_, content) => {
    const [anchor] = renderDescription(content)
    expect(anchor.textContent).toBe('app.ts:3:2')
    expect(anchor.title).toBe('/tmp/work/src/app.ts:3:2')
    expect(destination(anchor)).toBe('/tmp/work/src/app.ts:3:2')
  })

  it('keeps words an author chose for a file link, with its destination', () => {
    const [anchor] = renderDescription('Read [the runbook](/tmp/work/notes/plan.md).')
    expect(anchor.textContent).toBe('the runbook')
    expect(anchor.title).toBe('')
    expect(destination(anchor)).toBe('/tmp/work/notes/plan.md')
  })

  it('leaves comments, which render without the short links, unchanged', () => {
    const { container } = render(
      <CommentMarkdown
        content="See /tmp/work/notes/plan.md for the plan."
        onLinkClick={vi.fn()}
        allowFileUriLinks
        fileLinkExists={() => true}
      />
    )
    expect(container.querySelector('a')?.textContent).toBe('/tmp/work/notes/plan.md')
  })
})

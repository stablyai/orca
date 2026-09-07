// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  NATIVE_CHAT_FILE_HREF_PREFIX,
  routeNativeChatHref
} from '../../../../shared/native-chat-href-routing'
import CommentMarkdown from './CommentMarkdown'

describe('CommentMarkdown link click handler', () => {
  let root: Root | null = null
  let container: HTMLDivElement | null = null

  afterEach(() => {
    if (root) {
      act(() => root?.unmount())
    }
    container?.remove()
    root = null
    container = null
  })

  it('lets callers intercept rendered document links', () => {
    const onLinkClick = vi.fn((event: React.MouseEvent<HTMLElement>) => {
      event.preventDefault()
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    act(() => {
      root?.render(
        <CommentMarkdown
          variant="document"
          content="[docs](docs/guide.md)"
          onLinkClick={onLinkClick}
        />
      )
    })

    const anchor = container.querySelector<HTMLAnchorElement>('a[href="docs/guide.md"]')
    expect(anchor).not.toBeNull()
    const event = new window.MouseEvent('click', { bubbles: true, cancelable: true })

    act(() => {
      anchor?.dispatchEvent(event)
    })

    expect(onLinkClick).toHaveBeenCalledWith(expect.any(Object), 'docs/guide.md')
    expect(event.defaultPrevented).toBe(true)
  })

  it('intercepts auxiliary clicks on generated native file links', () => {
    const onLinkClick = vi.fn((event: React.MouseEvent<HTMLElement>) => {
      event.preventDefault()
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    act(() => {
      root?.render(
        <CommentMarkdown
          variant="document"
          content="Open src/foo.ts"
          onLinkClick={onLinkClick}
          linkifyFilePaths
        />
      )
    })

    const anchor = container.querySelector<HTMLAnchorElement>('a')
    const event = new window.MouseEvent('auxclick', {
      bubbles: true,
      cancelable: true,
      button: 1
    })

    act(() => {
      anchor?.dispatchEvent(event)
    })

    expect(onLinkClick).toHaveBeenCalledWith(expect.any(Object), expect.stringMatching(/^#orca-/))
    expect(event.defaultPrevented).toBe(true)
  })

  it('does not activate generated native file links on right-click', () => {
    const onLinkClick = vi.fn()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    act(() => {
      root?.render(
        <CommentMarkdown
          variant="document"
          content="Open src/foo.ts"
          onLinkClick={onLinkClick}
          linkifyFilePaths
        />
      )
    })

    const anchor = container.querySelector<HTMLAnchorElement>('a')
    const event = new window.MouseEvent('auxclick', {
      bubbles: true,
      cancelable: true,
      button: 2
    })

    act(() => {
      anchor?.dispatchEvent(event)
    })

    expect(onLinkClick).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })

  it('sanitizes file URI links unless the caller opts in', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    act(() => {
      root?.render(
        <CommentMarkdown variant="document" content="[source](file:///repo/worktree/src/main.ts)" />
      )
    })

    const anchor = container.querySelector<HTMLAnchorElement>('a')
    expect(anchor).not.toBeNull()
    expect(anchor?.getAttribute('href')).toBeNull()
  })

  it('sanitizes raw HTML file URI links unless the caller opts in', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    act(() => {
      root?.render(
        <CommentMarkdown
          variant="document"
          content='<a href="file:///repo/worktree/src/main.ts">source</a>'
        />
      )
    })

    const anchor = container.querySelector<HTMLAnchorElement>('a')
    expect(anchor).not.toBeNull()
    expect(anchor?.getAttribute('href')).toBeNull()
  })

  it('lets opted-in callers intercept rendered file URI links', () => {
    const onLinkClick = vi.fn()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    act(() => {
      root?.render(
        <CommentMarkdown
          variant="document"
          content="[source](file:///repo/worktree/src/main.ts)"
          onLinkClick={onLinkClick}
          allowFileUriLinks
        />
      )
    })

    const anchor = container.querySelector<HTMLAnchorElement>(
      'a[href="file:///repo/worktree/src/main.ts"]'
    )
    expect(anchor).not.toBeNull()
    const event = new window.MouseEvent('click', { bubbles: true, cancelable: true })

    act(() => {
      anchor?.dispatchEvent(event)
    })

    expect(onLinkClick).toHaveBeenCalledWith(
      expect.any(Object),
      'file:///repo/worktree/src/main.ts'
    )
    expect(event.defaultPrevented).toBe(true)
  })

  it('lets callers intercept rendered document images', () => {
    const onLinkClick = vi.fn((event: React.MouseEvent<HTMLElement>) => {
      event.preventDefault()
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    act(() => {
      root?.render(
        <CommentMarkdown
          variant="document"
          content="![diagram](assets/diagram.png)"
          onLinkClick={onLinkClick}
        />
      )
    })

    const image = container.querySelector<HTMLImageElement>('img[alt="diagram"]')
    expect(image?.getAttribute('src')).toBe('assets/diagram.png')
    const event = new window.MouseEvent('click', { bubbles: true, cancelable: true })

    act(() => {
      image?.dispatchEvent(event)
    })

    expect(onLinkClick).toHaveBeenCalledWith(expect.any(Object), 'assets/diagram.png')
    expect(event.defaultPrevented).toBe(true)
  })

  it('linkifies bare POSIX and Windows document paths without an extension allowlist', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    act(() => {
      root?.render(
        <CommentMarkdown
          variant="document"
          content={String.raw`Open /tmp/sta-6481-explainer.html, docs/review.docx, C:\Reports\final.pages, ./scripts/release, and src/release:12.`}
          onLinkClick={vi.fn()}
          linkifyFilePaths
        />
      )
    })

    const routes = Array.from(container.querySelectorAll<HTMLAnchorElement>('a')).map((anchor) =>
      routeNativeChatHref(anchor.getAttribute('href'))
    )
    expect(routes).toEqual([
      { kind: 'file', pathText: '/tmp/sta-6481-explainer.html', line: null },
      { kind: 'file', pathText: 'docs/review.docx', line: null },
      { kind: 'file', pathText: String.raw`C:\Reports\final.pages`, line: null },
      { kind: 'file', pathText: './scripts/release', line: null },
      { kind: 'file', pathText: 'src/release:12', line: null }
    ])
  })

  it('makes an inline-code file path clickable while preserving code styling', () => {
    const onLinkClick = vi.fn((event: React.MouseEvent<HTMLElement>) => event.preventDefault())
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    act(() => {
      root?.render(
        <CommentMarkdown
          variant="document"
          content={'Open `C:\\Reports\\release.docx`.'}
          onLinkClick={onLinkClick}
          linkifyFilePaths
        />
      )
    })

    const code = container.querySelector('code')
    const anchor = code?.closest('a')
    expect(anchor).not.toBeNull()
    expect(routeNativeChatHref(anchor?.getAttribute('href'))).toEqual({
      kind: 'file',
      pathText: String.raw`C:\Reports\release.docx`,
      line: null
    })

    act(() => {
      anchor?.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    expect(onLinkClick).toHaveBeenCalledOnce()
  })

  it('leaves prose-shaped slash tokens and numeric versions unlinked', () => {
    const proseFalsePositives = ['and/or', 'TCP/IP', '24/7', 'N/A', 'km/h', 'A/B test']
    const inlineCodeFalsePositives = ['origin/main', 'v1.2.3', '1.0']
    const quotedFalsePositives = ['"and/or"', '"A/B test"']
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    act(() => {
      root?.render(
        <CommentMarkdown
          variant="document"
          content={`${proseFalsePositives.join(', ')}; ${inlineCodeFalsePositives.map((value) => `\`${value}\``).join(', ')}; ${quotedFalsePositives.join(', ')}`}
          onLinkClick={vi.fn()}
          linkifyFilePaths
        />
      )
    })

    expect(container.querySelectorAll('a')).toHaveLength(0)
    for (const value of proseFalsePositives) {
      expect(container.textContent).toContain(value)
    }
    for (const value of quotedFalsePositives) {
      expect(container.textContent).toContain(value)
    }
    expect(Array.from(container.querySelectorAll('code')).map((code) => code.textContent)).toEqual(
      inlineCodeFalsePositives
    )
  })

  it('links each relative path separately when prose joins them', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    act(() => {
      root?.render(
        <CommentMarkdown
          variant="document"
          content="Updated src/foo.ts and src/bar.ts, then docs/My Folder/notes.md."
          onLinkClick={vi.fn()}
          linkifyFilePaths
        />
      )
    })

    expect(Array.from(container.querySelectorAll('a')).map((anchor) => anchor.textContent)).toEqual(
      ['src/foo.ts', 'src/bar.ts', 'docs/My Folder/notes.md']
    )
  })

  it('links quoted spaced-first-segment paths around apostrophes', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    act(() => {
      root?.render(
        <CommentMarkdown
          variant="document"
          content={"Don't skip \"Brennan's Folder/notes.md\"; open 'My Folder/guide.md'."}
          onLinkClick={vi.fn()}
          linkifyFilePaths
        />
      )
    })

    const anchors = container.querySelectorAll<HTMLAnchorElement>('a')
    expect(Array.from(anchors).map((anchor) => anchor.textContent)).toEqual([
      "Brennan's Folder/notes.md",
      'My Folder/guide.md'
    ])
    expect(container.textContent).toBe(
      "Don't skip \"Brennan's Folder/notes.md\"; open 'My Folder/guide.md'."
    )
    expect(
      Array.from(anchors).map((anchor) => routeNativeChatHref(anchor.getAttribute('href')))
    ).toEqual([
      { kind: 'file', pathText: "Brennan's Folder/notes.md", line: null },
      { kind: 'file', pathText: 'My Folder/guide.md', line: null }
    ])
  })

  it('links a spaced-first-segment relative path when inline code disambiguates it', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    act(() => {
      root?.render(
        <CommentMarkdown
          variant="document"
          content="Open `My Folder/notes.md`."
          onLinkClick={vi.fn()}
          linkifyFilePaths
        />
      )
    })

    const anchor = container.querySelector<HTMLAnchorElement>('a')
    expect(anchor?.textContent).toBe('My Folder/notes.md')
    expect(routeNativeChatHref(anchor?.getAttribute('href'))).toEqual({
      kind: 'file',
      pathText: 'My Folder/notes.md',
      line: null
    })
  })

  it('requires path shape before a spaced line suffix can make a link', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    act(() => {
      root?.render(
        <CommentMarkdown
          variant="document"
          content='Keep `aspect 16:9` and "John 3:16" as references.'
          onLinkClick={vi.fn()}
          linkifyFilePaths
        />
      )
    })

    expect(container.querySelectorAll('a')).toHaveLength(0)
    expect(container.querySelector('code')?.textContent).toBe('aspect 16:9')
    expect(container.textContent).toContain('"John 3:16"')
  })

  it('preserves line suffixes on valid spaced path shapes', () => {
    const content =
      'Open "My Folder/notes:12", `My Notes.md:7`, and "C:\\My Folder\\notes.txt:12:3".'
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    act(() => {
      root?.render(
        <CommentMarkdown
          variant="document"
          content={content}
          onLinkClick={vi.fn()}
          linkifyFilePaths
        />
      )
    })

    const anchors = Array.from(container.querySelectorAll<HTMLAnchorElement>('a'))
    expect(anchors.map((anchor) => anchor.textContent)).toEqual([
      'My Folder/notes:12',
      'My Notes.md:7',
      String.raw`C:\My Folder\notes.txt:12:3`
    ])
    expect(anchors.map((anchor) => routeNativeChatHref(anchor.getAttribute('href')))).toEqual([
      { kind: 'file', pathText: 'My Folder/notes:12', line: null },
      { kind: 'file', pathText: 'My Notes.md:7', line: null },
      { kind: 'file', pathText: String.raw`C:\My Folder\notes.txt:12:3`, line: null }
    ])
  })

  it('links complete Unicode paths and extensions that begin with a digit', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    act(() => {
      root?.render(
        <CommentMarkdown
          variant="document"
          content="Open /tmp/报告.html, docs/报告/file.html, docs/café/report.pdf, and docs/archive.7z."
          onLinkClick={vi.fn()}
          linkifyFilePaths
        />
      )
    })

    expect(Array.from(container.querySelectorAll('a')).map((anchor) => anchor.textContent)).toEqual(
      ['/tmp/报告.html', 'docs/报告/file.html', 'docs/café/report.pdf', 'docs/archive.7z']
    )
  })

  it('never links an ASCII suffix inside a path containing an unsupported character', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    act(() => {
      root?.render(
        <CommentMarkdown
          variant="document"
          content="Leave /tmp/$draft/report.html as one path or plain text."
          onLinkClick={vi.fn()}
          linkifyFilePaths
        />
      )
    })

    expect(container.querySelectorAll('a')).toHaveLength(0)
    expect(container.textContent).toContain('/tmp/$draft/report.html')
  })

  it('links paths before common sentence punctuation', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    act(() => {
      root?.render(
        <CommentMarkdown
          variant="document"
          content="Open src/foo.ts! Read docs/guide.md? View assets/report.pdf—then continue."
          onLinkClick={vi.fn()}
          linkifyFilePaths
        />
      )
    })

    expect(Array.from(container.querySelectorAll('a')).map((anchor) => anchor.textContent)).toEqual(
      ['src/foo.ts', 'docs/guide.md', 'assets/report.pdf']
    )
  })

  it('links paths after CLI assignment and before Unicode sentence punctuation', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    act(() => {
      root?.render(
        <CommentMarkdown
          variant="document"
          content="Run --config=./config.yaml。然后打开 docs/指南.md！再看 docs/报告.pdf？"
          onLinkClick={vi.fn()}
          linkifyFilePaths
        />
      )
    })

    expect(Array.from(container.querySelectorAll('a')).map((anchor) => anchor.textContent)).toEqual(
      ['./config.yaml', 'docs/指南.md', 'docs/报告.pdf']
    )
  })

  it('does not link partial paths across unsupported punctuation', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    act(() => {
      root?.render(
        <CommentMarkdown
          variant="document"
          content="Leave src/foo.ts!draft/file.html, src/foo.ts—draft/file.html."
          onLinkClick={vi.fn()}
          linkifyFilePaths
        />
      )
    })

    expect(container.querySelectorAll('a')).toHaveLength(0)
  })

  it('prevents the default action for an unresolved internal file href', () => {
    const onLinkClick = vi.fn()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    act(() => {
      root?.render(
        <CommentMarkdown
          variant="document"
          content="Open ~/x"
          onLinkClick={onLinkClick}
          linkifyFilePaths
        />
      )
    })

    const anchor = container.querySelector<HTMLAnchorElement>('a')
    expect(anchor?.getAttribute('href')).toMatch(new RegExp(`^${NATIVE_CHAT_FILE_HREF_PREFIX}`))
    const event = new window.MouseEvent('click', { bubbles: true, cancelable: true })

    act(() => {
      anchor?.dispatchEvent(event)
    })

    expect(onLinkClick).toHaveBeenCalledOnce()
    expect(event.defaultPrevented).toBe(true)
  })

  it('normalizes Windows markdown hrefs but leaves fenced paths as source text', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    act(() => {
      root?.render(
        <CommentMarkdown
          variant="document"
          content={[
            String.raw`[report](C:\Reports\summary.pdf)`,
            '',
            '```text',
            '/tmp/not-a-link.html',
            '```'
          ].join('\n')}
          onLinkClick={vi.fn()}
          linkifyFilePaths
        />
      )
    })

    const anchors = container.querySelectorAll<HTMLAnchorElement>('a')
    expect(anchors).toHaveLength(1)
    expect(routeNativeChatHref(anchors[0]?.getAttribute('href'))).toEqual({
      kind: 'file',
      pathText: String.raw`C:\Reports\summary.pdf`,
      line: null
    })
    expect(container.querySelector('pre')?.textContent).toContain('/tmp/not-a-link.html')
  })
})

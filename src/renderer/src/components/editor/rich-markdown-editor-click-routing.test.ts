// @vitest-environment happy-dom

import { Editor, type JSONContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleRichMarkdownEditorClick } from './rich-markdown-editor-click-routing'
import {
  registerHttpLinkStoreAccessor,
  registerWorkspaceHttpLinkBrowserOpener,
  type HttpLinkSourceOwner
} from '@/lib/http-link-routing'
import { createRichMarkdownHtmlSuperscriptLinkContext } from './rich-markdown-html-superscript-link-context'

type RoutingState = {
  settings: { activeRuntimeEnvironmentId?: string } & Record<string, unknown>
  worktreesByRepo: Record<
    string,
    { id: string; repoId: string; hostId: 'local' | `runtime:${string}` }[]
  >
  canOpenOwnedBrowser: boolean
}
const routing = vi.hoisted((): RoutingState => ({
  settings: { openLinksInApp: false, openLinksInAppModifierInverts: false },
  worktreesByRepo: {},
  canOpenOwnedBrowser: true
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => routing } }))
vi.mock('@/lib/workspace-browser-tab-open', () => ({
  canOpenWorkspaceBrowserTabOnRuntime: () => routing.canOpenOwnedBrowser,
  canOpenWorkspaceBrowserTabOnSsh: () => routing.canOpenOwnedBrowser
}))

const openUrl = vi.fn()
const openFileUri = vi.fn()
const createBrowserTab = vi.fn()
const openOwnedBrowser = vi.fn(async (): Promise<string | null> => null)
const activateMarkdownLink = vi.fn()
let editor: Editor | null = null

beforeEach(() => {
  vi.clearAllMocks()
  routing.settings = {
    openLinksInApp: false,
    openLinksInAppModifierInverts: false
  }
  routing.worktreesByRepo = {
    repo: [{ id: 'wt-1', repoId: 'repo', hostId: 'local' }]
  }
  routing.canOpenOwnedBrowser = true
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      shell: { openUrl, openFileUri, pathExists: vi.fn(async () => true) }
    }
  })
  registerHttpLinkStoreAccessor(() => ({
    settings: routing.settings,
    setActiveWorktree: vi.fn(),
    createBrowserTab
  }))
  registerWorkspaceHttpLinkBrowserOpener(openOwnedBrowser)
})
afterEach(() => {
  editor?.destroy()
  editor = null
  registerWorkspaceHttpLinkBrowserOpener(null)
})

function clickLink({
  sourceOwner = { kind: 'local' },
  isMac = true,
  shiftKey = true,
  modKey = true,
  href = 'https://example.com/docs',
  content,
  pos = 2,
  targetSelector = 'a'
}: {
  sourceOwner?: HttpLinkSourceOwner
  isMac?: boolean
  shiftKey?: boolean
  modKey?: boolean
  href?: string
  content?: string | JSONContent
  pos?: number
  targetSelector?: string
} = {}): boolean {
  editor = new Editor({
    extensions: [StarterKit],
    content: content ?? `<p><a href="${href}">example</a></p>`
  })
  const event = new MouseEvent('click', {
    metaKey: isMac && modKey,
    ctrlKey: !isMac && modKey,
    shiftKey,
    cancelable: true
  })
  event.preventDefault()
  const target = editor.view.dom.querySelector(targetSelector)
  if (!target) {
    throw new Error(`Missing click target: ${targetSelector}`)
  }
  target.dispatchEvent(event)
  return handleRichMarkdownEditorClick({
    activateMarkdownLink,
    editorRef: { current: editor },
    event,
    filePath: '/repo/docs/README.md',
    isMac,
    htmlSuperscriptLinkContext: createRichMarkdownHtmlSuperscriptLinkContext({
      sourceOwner,
      sourceFilePath: '/repo/docs/README.md',
      worktreeId: 'wt-1',
      worktreeRoot: '/repo'
    }),
    markdownCommentsRef: { current: [] },
    markdownSourceLineOffsetRef: { current: 0 },
    onOpenDocLinkRef: { current: undefined },
    pos,
    rootRef: { current: null },
    scrollRichMarkdownReviewNoteCardIntoView: vi.fn(),
    view: editor.view,
    worktreeId: 'wt-1',
    worktreeRoot: '/repo'
  })
}

describe('rich Markdown alternate browser click', () => {
  it.each([true, false])('opens Orca when the system browser is primary (Mac: %s)', (isMac) => {
    expect(clickLink({ isMac })).toBe(true)
    expect(openOwnedBrowser).toHaveBeenCalledWith({
      workspaceId: 'wt-1',
      url: 'https://example.com/docs',
      intent: { kind: 'url' },
      linkContext: { linkIntent: null, canReveal: expect.any(Function) }
    })
    expect(openUrl).not.toHaveBeenCalled()
    expect(activateMarkdownLink).not.toHaveBeenCalled()
  })

  it.each([true, false])(
    'opens the system browser when Orca is primary (invert: %s)',
    (inverts) => {
      routing.settings = {
        openLinksInApp: true,
        openLinksInAppModifierInverts: inverts
      }
      expect(clickLink()).toBe(true)
      expect(openUrl).toHaveBeenCalledWith('https://example.com/docs')
      expect(createBrowserTab).not.toHaveBeenCalled()
    }
  )

  it.each<HttpLinkSourceOwner>([
    { kind: 'ssh', connectionId: 'conn-1' },
    { kind: 'runtime', runtimeEnvironmentId: 'env-1' }
  ])('opens the alternate Orca browser on the source owner: %j', (sourceOwner) => {
    expect(clickLink({ sourceOwner })).toBe(true)
    expect(openOwnedBrowser).toHaveBeenCalledWith({
      workspaceId: 'wt-1',
      url: 'https://example.com/docs',
      intent: { kind: 'url' },
      linkContext: { linkIntent: null, canReveal: expect.any(Function) },
      ...(sourceOwner.kind === 'ssh'
        ? { expectedSshConnectionId: sourceOwner.connectionId }
        : sourceOwner.kind === 'runtime'
          ? { expectedRuntimeEnvironmentId: sourceOwner.runtimeEnvironmentId }
          : {})
    })
    expect(createBrowserTab).not.toHaveBeenCalled()
    expect(openUrl).not.toHaveBeenCalled()
  })

  it('uses the sole system destination when the remote browser is unavailable', () => {
    routing.canOpenOwnedBrowser = false
    expect(clickLink({ sourceOwner: { kind: 'ssh', connectionId: 'conn-1' } })).toBe(true)
    expect(openUrl).toHaveBeenCalledWith('https://example.com/docs')
    expect(openOwnedBrowser).not.toHaveBeenCalled()
  })

  it('keeps unresolved ownership inert', () => {
    expect(clickLink({ sourceOwner: { kind: 'unknown' } })).toBe(true)
    expect(openUrl).not.toHaveBeenCalled()
    expect(createBrowserTab).not.toHaveBeenCalled()
    expect(openOwnedBrowser).not.toHaveBeenCalled()
  })

  it('keeps plain modifier clicks on the existing activation path', () => {
    expect(clickLink({ shiftKey: false })).toBe(true)
    expect(activateMarkdownLink).toHaveBeenCalledWith(
      'https://example.com/docs',
      expect.objectContaining({
        worktreeId: 'wt-1',
        sourceOwner: { kind: 'local' }
      })
    )
    expect(createBrowserTab).not.toHaveBeenCalled()
  })

  it('keeps Shift alone from opening a link', () => {
    expect(clickLink({ modKey: false })).toBe(false)
    expect(activateMarkdownLink).not.toHaveBeenCalled()
    expect(createBrowserTab).not.toHaveBeenCalled()
    expect(openUrl).not.toHaveBeenCalled()
  })

  it('keeps Shift-modified relative files on the client OS path', async () => {
    expect(clickLink({ href: 'child.md' })).toBe(true)
    await vi.waitFor(() =>
      expect(openFileUri).toHaveBeenCalledWith('file:///repo/docs/child.md', 'local')
    )
    // The click is a user act, so its existence check may start a stopped WSL distro (E9).
    expect(window.api.shell.pathExists).toHaveBeenCalledWith('/repo/docs/child.md', {
      wakeWslDistro: true
    })
    expect(activateMarkdownLink).not.toHaveBeenCalled()
    expect(createBrowserTab).not.toHaveBeenCalled()
  })

  it('opens a local document through the client OS while a server is focused', async () => {
    routing.settings = {
      ...routing.settings,
      activeRuntimeEnvironmentId: 'env-1'
    }
    expect(clickLink({ href: 'child.md' })).toBe(true)
    await vi.waitFor(() =>
      expect(openFileUri).toHaveBeenCalledWith('file:///repo/docs/child.md', 'local')
    )
  })

  it('refuses a runtime-owned document even when the path exists locally', async () => {
    routing.worktreesByRepo = {
      repo: [{ id: 'wt-1', repoId: 'repo', hostId: 'runtime:env-1' }]
    }
    expect(clickLink({ href: 'child.md' })).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(openFileUri).not.toHaveBeenCalled()
  })
})

describe('rich Markdown link click targets', () => {
  it('opens the first character after plain text', () => {
    expect(
      clickLink({
        shiftKey: false,
        content: '<p>plain <a href="child.md">X</a> tail</p>',
        pos: 7
      })
    ).toBe(true)
    expect(activateMarkdownLink).toHaveBeenCalledWith('child.md', expect.any(Object))
  })

  it('opens the clicked adjacent link at their shared text position', () => {
    expect(
      clickLink({
        shiftKey: false,
        content: '<p><a href="first.md">A</a><a href="second.md">B</a></p>',
        targetSelector: 'a:last-child',
        pos: 2
      })
    ).toBe(true)
    expect(activateMarkdownLink).toHaveBeenCalledWith('second.md', expect.any(Object))
  })

  it('opens a link from nested formatting at its leading boundary', () => {
    expect(
      clickLink({
        shiftKey: false,
        content: '<p>plain <a href="child.md"><strong>X</strong></a></p>',
        targetSelector: 'strong',
        pos: 7
      })
    ).toBe(true)
    expect(activateMarkdownLink).toHaveBeenCalledWith('child.md', expect.any(Object))
  })

  it('keeps neighboring prose inert even when its caret position has a link mark', () => {
    expect(
      clickLink({
        shiftKey: false,
        content: '<p><a href="child.md">X</a><em>tail</em></p>',
        targetSelector: 'em',
        pos: 2
      })
    ).toBe(false)
    expect(activateMarkdownLink).not.toHaveBeenCalled()
  })

  it.each(['file:///repo/docs/child.md', 'C:\\repo\\docs\\child.md'])(
    'opens %s even though the rendered anchor drops its href',
    (href) => {
      expect(
        clickLink({
          shiftKey: false,
          content: {
            type: 'doc',
            content: [
              {
                type: 'paragraph',
                content: [
                  { type: 'text', text: 'example', marks: [{ type: 'link', attrs: { href } }] }
                ]
              }
            ]
          }
        })
      ).toBe(true)
      expect(activateMarkdownLink).toHaveBeenCalledWith(href, expect.any(Object))
    }
  )
})

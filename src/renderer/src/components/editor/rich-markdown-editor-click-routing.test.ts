// @vitest-environment happy-dom

import { Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleRichMarkdownEditorClick } from './rich-markdown-editor-click-routing'
import {
  registerHttpLinkStoreAccessor,
  registerWorkspaceHttpLinkBrowserOpener,
  type HttpLinkSourceOwner
} from '@/lib/http-link-routing'
import { createRichMarkdownHtmlSuperscriptLinkContext } from './rich-markdown-html-superscript-link-context'

const routing = vi.hoisted(() => ({
  settings: { openLinksInApp: false, openLinksInAppModifierInverts: false },
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
const openOwnedBrowser = vi.fn(async () => {})
const activateMarkdownLink = vi.fn()
let editor: Editor | null = null

beforeEach(() => {
  vi.clearAllMocks()
  routing.settings = { openLinksInApp: false, openLinksInAppModifierInverts: false }
  routing.canOpenOwnedBrowser = true
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { shell: { openUrl, openFileUri, pathExists: vi.fn(async () => true) } }
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
  href = 'https://example.com/docs'
}: {
  sourceOwner?: HttpLinkSourceOwner
  isMac?: boolean
  shiftKey?: boolean
  modKey?: boolean
  href?: string
} = {}): boolean {
  editor = new Editor({
    extensions: [StarterKit],
    content: `<p><a href="${href}">example</a></p>`
  })
  return handleRichMarkdownEditorClick({
    activateMarkdownLink,
    editorRef: { current: editor },
    event: new MouseEvent('click', {
      metaKey: isMac && modKey,
      ctrlKey: !isMac && modKey,
      shiftKey
    }),
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
    pos: 2,
    rootRef: { current: null },
    scrollRichMarkdownReviewNoteCardIntoView: vi.fn(),
    settings: {},
    view: editor.view,
    worktreeId: 'wt-1',
    worktreeRoot: '/repo'
  })
}

describe('rich Markdown alternate browser click', () => {
  it.each([true, false])('opens Orca when the system browser is primary (Mac: %s)', (isMac) => {
    expect(clickLink({ isMac })).toBe(true)
    expect(createBrowserTab).toHaveBeenCalledWith('wt-1', 'https://example.com/docs', {
      activate: true
    })
    expect(openUrl).not.toHaveBeenCalled()
    expect(activateMarkdownLink).not.toHaveBeenCalled()
  })

  it.each([true, false])(
    'opens the system browser when Orca is primary (invert: %s)',
    (inverts) => {
      routing.settings = { openLinksInApp: true, openLinksInAppModifierInverts: inverts }
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
      expect.objectContaining({ worktreeId: 'wt-1', sourceOwner: { kind: 'local' } })
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
    await vi.waitFor(() => expect(openFileUri).toHaveBeenCalledWith('file:///repo/docs/child.md'))
    expect(activateMarkdownLink).not.toHaveBeenCalled()
    expect(createBrowserTab).not.toHaveBeenCalled()
  })
})

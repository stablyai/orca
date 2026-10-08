// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import type { LinkActionRequest } from '@/components/link-actions/link-action-request'
import type { NativeChatFileLinkContext } from './native-chat-file-link'
import { useNativeChatFileLinkClick } from './use-native-chat-file-link-click'
import { NativeChatToolLine } from './NativeChatToolLine'
import { NativeChatDiffCard } from './NativeChatDiffCard'

const mocks = vi.hoisted(() => {
  const noSettings: Record<string, unknown> = {}
  return {
    openDetectedFilePath: vi.fn(),
    showNotFound: vi.fn(),
    showUnverifiable: vi.fn(),
    showUnresolved: vi.fn(),
    buildFileLinkActions: vi.fn(),
    settings: noSettings
  }
})

vi.mock('@/components/terminal-pane/terminal-file-open-routing', () => ({
  openDetectedFilePath: mocks.openDetectedFilePath
}))
vi.mock('@/components/terminal-pane/terminal-file-link-actions', () => ({
  buildFileLinkActions: mocks.buildFileLinkActions
}))
vi.mock('./native-chat-http-link-source-owner', () => ({
  resolveNativeChatHttpLinkSourceOwner: () => ({ kind: 'local' })
}))
vi.mock('./native-chat-file-link-toasts', () => ({
  showFileLinkNotFoundToast: mocks.showNotFound,
  showFileLinkUnverifiableToast: mocks.showUnverifiable,
  showFileLinkUnresolvedToast: mocks.showUnresolved
}))
vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector({}),
    { getState: () => ({ settings: mocks.settings }) }
  )
}))

const context: NativeChatFileLinkContext = {
  worktreeId: 'wt-1',
  worktreePath: '/repo',
  runtimeEnvironmentId: null
}

function Transcript(props: {
  markdown: string
  linkContext?: NativeChatFileLinkContext
  request?: (request: LinkActionRequest) => void
}): React.JSX.Element {
  const onLinkClick = useNativeChatFileLinkClick(props.linkContext ?? context, props.request)
  return (
    <CommentMarkdown
      content={props.markdown}
      variant="document"
      onLinkClick={onLinkClick}
      allowFileUriLinks
      linkifyFilePaths
    />
  )
}

function clickLink(name: string): void {
  fireEvent.click(screen.getByRole('link', { name }))
}

function ToolTarget({
  path = 'src/app.ts',
  surface = 'tool',
  request,
  linkContext = context
}: {
  path?: string
  surface?: 'tool' | 'diff'
  request: (request: LinkActionRequest) => void
  linkContext?: NativeChatFileLinkContext
}): React.JSX.Element {
  const onLinkClick = useNativeChatFileLinkClick(linkContext, request)
  return surface === 'tool' ? (
    <NativeChatToolLine
      block={{ type: 'tool-call', name: 'Read', input: { file_path: path } }}
      result={{ type: 'tool-result', output: 'contents' }}
      onLinkClick={onLinkClick}
    />
  ) : (
    <NativeChatDiffCard
      file={{
        path,
        oldPath: null,
        changeKind: 'edited',
        lines: [{ kind: 'add', text: 'new', oldLineNumber: null, newLineNumber: 1 }],
        added: 1,
        removed: 0,
        lineNumbersKnown: true,
        truncated: false
      }}
      onLinkClick={onLinkClick}
    />
  )
}

function failLastOpen(verdict: 'missing' | 'unverifiable', error: unknown = new Error('x')): void {
  mocks.openDetectedFilePath.mock.calls.at(-1)?.[3].onOpenFailure({ verdict, error })
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.restoreAllMocks()
  mocks.settings = {}
})

describe('tool and edit-card file activation', () => {
  it.each([
    ['Mac', { metaKey: true }, 'none', 'Enter', 'tool'],
    ['Linux', { ctrlKey: true }, 'actions', ' ', 'tool'],
    ['Windows', { ctrlKey: true }, 'open', 'Enter', 'diff'],
    ['Mac', { shiftKey: true }, 'actions', ' ', 'diff'],
    ['Linux', { shiftKey: true }, 'open', 'Enter', 'tool'],
    ['Windows', { shiftKey: true }, 'none', ' ', 'diff']
  ] as const)(
    'preserves %s keyboard intent with %j and %s policy',
    (platform, modifiers, terminalLinkClickBehavior, key, surface) => {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(platform)
      mocks.settings = { terminalLinkClickBehavior }
      const request = vi.fn()
      render(<ToolTarget request={request} surface={surface} />)
      const link = screen.getByRole('link')
      link.focus()

      fireEvent.keyDown(link, { key, ...modifiers })

      expect(mocks.openDetectedFilePath).toHaveBeenCalledExactlyOnceWith(
        '/repo/src/app.ts',
        null,
        null,
        expect.objectContaining({ openWithSystemDefault: 'shiftKey' in modifiers })
      )
      expect(request).not.toHaveBeenCalled()
      expect(screen.getByRole('button', { expanded: false }).getAttribute('aria-expanded')).toBe(
        'false'
      )
      expect(document.activeElement).toBe(link)
    }
  )

  it.each(['Enter', ' '])(
    'anchors plain %j activation under the link and restores its focus',
    (key) => {
      mocks.buildFileLinkActions.mockReturnValue({ destination: '/repo/src/app.ts', kind: 'file' })
      const request = vi.fn<(request: LinkActionRequest) => void>()
      render(<ToolTarget request={request} />)
      const link = screen.getByRole('link')
      vi.spyOn(link, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 20, 30, 40))

      fireEvent.keyDown(link, { key })

      expect(request).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ anchorX: 10, anchorY: 60 })
      )
      expect(mocks.openDetectedFilePath).not.toHaveBeenCalled()
      request.mock.calls[0]?.[0].restoreFocus()
      expect(document.activeElement).toBe(link)
      expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('false')
    }
  )

  it.each([
    ['/repo/report:12', '/repo/report:12', 'tool'],
    ['/repo/report:0', '/repo/report:0', 'diff'],
    ['/repo/report:12:4', '/repo/report:12:4', 'diff'],
    ['/repo/ leading ', '/repo/ leading ', 'tool'],
    [' leading ', '/repo/ leading ', 'diff'],
    ['notes%23?#.md', '/repo/notes%23?#.md', 'tool'],
    ['https:notes.md', '/repo/https:notes.md', 'diff'],
    ['file:notes.md', '/repo/file:notes.md', 'tool'],
    ['../sibling/readme.md', '/sibling/readme.md', 'tool']
  ] as const)(
    'opens literal target %j as %j from the %s surface',
    (path, absolutePath, surface) => {
      mocks.settings = { terminalLinkClickBehavior: 'open' }
      render(<ToolTarget path={path} request={vi.fn()} surface={surface} />)

      fireEvent.click(screen.getByRole('link'))

      expect(mocks.openDetectedFilePath).toHaveBeenCalledExactlyOnceWith(
        absolutePath,
        null,
        null,
        expect.objectContaining({ worktreePath: '/repo' })
      )
    }
  )

  it('builds the menu for the exact sibling target without opening it', () => {
    const request = vi.fn()
    render(<ToolTarget path="../sibling/readme.md" request={request} />)

    fireEvent.click(screen.getByRole('link'))

    expect(mocks.buildFileLinkActions).toHaveBeenCalledExactlyOnceWith(
      '/sibling/readme.md',
      null,
      null,
      expect.objectContaining({ worktreeId: 'wt-1' }),
      { kind: 'local' }
    )
    expect(request).toHaveBeenCalledOnce()
    expect(mocks.openDetectedFilePath).not.toHaveBeenCalled()
  })

  it.each(['tool', 'reply'] as const)(
    'keeps an unresolved %s plain click quiet under none',
    (surface) => {
      mocks.settings = { terminalLinkClickBehavior: 'none' }
      const request = vi.fn()
      render(
        surface === 'tool' ? (
          <ToolTarget path="~/notes.md" request={request} />
        ) : (
          <Transcript markdown="See `~/notes.md`." request={request} />
        )
      )

      fireEvent.click(screen.getByRole('link'))

      expect(mocks.showUnresolved).not.toHaveBeenCalled()
      expect(mocks.showNotFound).not.toHaveBeenCalled()
      expect(mocks.openDetectedFilePath).not.toHaveBeenCalled()
      expect(request).not.toHaveBeenCalled()
    }
  )

  it.each(['tool', 'reply'] as const)(
    'reports an unresolved %s modifier action under none',
    (surface) => {
      mocks.settings = { terminalLinkClickBehavior: 'none' }
      const request = vi.fn()
      render(
        surface === 'tool' ? (
          <ToolTarget path="~/notes.md" request={request} />
        ) : (
          <Transcript markdown="See `~/notes.md`." request={request} />
        )
      )

      if (surface === 'tool') {
        fireEvent.keyDown(screen.getByRole('link'), { key: 'Enter', shiftKey: true })
      } else {
        fireEvent.click(screen.getByRole('link'), { shiftKey: true })
      }

      expect(mocks.showUnresolved).toHaveBeenCalledExactlyOnceWith('~/notes.md')
      expect(mocks.showNotFound).not.toHaveBeenCalled()
      expect(mocks.openDetectedFilePath).not.toHaveBeenCalled()
      expect(request).not.toHaveBeenCalled()
    }
  )
})

describe('useNativeChatFileLinkClick', () => {
  it('does not underline a bare file name the click could not open', () => {
    render(<Transcript markdown="I updated `deck.md` and 'notes.md'." />)

    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByText('deck.md').tagName).toBe('CODE')
  })

  it('reports a missing relative path instead of doing nothing', () => {
    render(<Transcript markdown="I updated `docs/deck.md`." />)

    clickLink('docs/deck.md')

    expect(mocks.openDetectedFilePath).toHaveBeenCalledWith(
      '/repo/docs/deck.md',
      null,
      null,
      expect.objectContaining({ worktreeId: 'wt-1', onOpenFailure: expect.any(Function) })
    )
    failLastOpen('missing')
    expect(mocks.showNotFound).toHaveBeenCalledWith('/repo/docs/deck.md')
  })

  it('reports a host that could not answer without claiming the file is gone', () => {
    render(<Transcript markdown="I updated `docs/deck.md`." />)

    clickLink('docs/deck.md')
    const error = new Error('SSH connection closed')
    failLastOpen('unverifiable', error)

    expect(mocks.showUnverifiable).toHaveBeenCalledWith('/repo/docs/deck.md', error)
    expect(mocks.showNotFound).not.toHaveBeenCalled()
  })

  it('reports a missing absolute path', () => {
    render(<Transcript markdown="See `/repo/src/app.ts:12`." />)

    clickLink('/repo/src/app.ts:12')

    expect(mocks.openDetectedFilePath).toHaveBeenCalledWith(
      '/repo/src/app.ts',
      12,
      null,
      expect.anything()
    )
    failLastOpen('missing')
    expect(mocks.showNotFound).toHaveBeenCalledWith('/repo/src/app.ts')
  })

  it('opens an explicit markdown link to a bare file name with a line', () => {
    render(<Transcript markdown="[the readme](README.md:5)" />)

    clickLink('the readme')

    expect(mocks.openDetectedFilePath).toHaveBeenCalledWith(
      '/repo/README.md',
      5,
      null,
      expect.anything()
    )
  })

  it('resolves URL syntax in explicit markdown links once', () => {
    render(<Transcript markdown="[plan](docs/plan.md#L7) and [notes](docs/release%20notes.md)" />)

    clickLink('plan')
    clickLink('notes')

    expect(mocks.openDetectedFilePath).toHaveBeenNthCalledWith(
      1,
      '/repo/docs/plan.md',
      7,
      null,
      expect.anything()
    )
    expect(mocks.openDetectedFilePath).toHaveBeenNthCalledWith(
      2,
      '/repo/docs/release notes.md',
      null,
      null,
      expect.anything()
    )
  })

  it('opens file URIs written in inline code and prose', () => {
    render(
      <Transcript markdown="See `file:///repo/src/app.ts` and file:///repo/docs/release%20notes.md#L4 now." />
    )

    clickLink('file:///repo/src/app.ts')
    clickLink('file:///repo/docs/release%20notes.md#L4')

    expect(mocks.openDetectedFilePath).toHaveBeenNthCalledWith(
      1,
      '/repo/src/app.ts',
      null,
      null,
      expect.anything()
    )
    expect(mocks.openDetectedFilePath).toHaveBeenNthCalledWith(
      2,
      '/repo/docs/release notes.md',
      4,
      null,
      expect.anything()
    )
  })

  it('keeps # in a linked path instead of treating it as a fragment', () => {
    render(<Transcript markdown="Edit `My C# App/Program.cs` next." />)

    clickLink('My C# App/Program.cs')

    expect(mocks.openDetectedFilePath).toHaveBeenCalledWith(
      '/repo/My C# App/Program.cs',
      null,
      null,
      expect.anything()
    )
  })

  it('reports a link it cannot resolve without claiming the file is missing', () => {
    render(
      <Transcript
        markdown="Plan: `~/.claude/plans/plan.md`"
        linkContext={{ ...context, worktreePath: '/workspaces/repo' }}
      />
    )

    clickLink('~/.claude/plans/plan.md')

    expect(mocks.openDetectedFilePath).not.toHaveBeenCalled()
    expect(mocks.showUnresolved).toHaveBeenCalledWith('~/.claude/plans/plan.md')
    expect(mocks.showNotFound).not.toHaveBeenCalled()
  })

  describe('with the file popover', () => {
    const rows = { destination: '/repo/src/app.ts', kind: 'file', primary: { label: 'Open file' } }

    it('offers the terminal file actions on a plain click', () => {
      mocks.buildFileLinkActions.mockReturnValue(rows)
      const request = vi.fn()
      render(<Transcript markdown="See `src/app.ts:12`." request={request} />)

      clickLink('src/app.ts:12')

      expect(mocks.openDetectedFilePath).not.toHaveBeenCalled()
      expect(mocks.buildFileLinkActions).toHaveBeenCalledWith(
        '/repo/src/app.ts',
        12,
        null,
        expect.objectContaining({ worktreeId: 'wt-1', onOpenFailure: expect.any(Function) }),
        { kind: 'local' }
      )
      expect(request).toHaveBeenCalledWith(expect.objectContaining(rows))
    })

    it.each([
      [
        'a modifier click',
        { [navigator.userAgent.includes('Mac') ? 'metaKey' : 'ctrlKey']: true },
        false
      ],
      ['a Shift click', { shiftKey: true }, true]
    ])('opens outright on %s', (_name, modifiers, openWithSystemDefault) => {
      const request = vi.fn()
      render(<Transcript markdown="See `src/app.ts`." request={request} />)

      fireEvent.click(screen.getByRole('link', { name: 'src/app.ts' }), modifiers)

      expect(request).not.toHaveBeenCalled()
      expect(mocks.openDetectedFilePath).toHaveBeenCalledWith(
        '/repo/src/app.ts',
        null,
        null,
        expect.objectContaining({ openWithSystemDefault })
      )
    })

    it.each([
      ['open', 1],
      ['none', 0]
    ])('follows a %s link-click setting', (terminalLinkClickBehavior, opens) => {
      mocks.settings = { terminalLinkClickBehavior }
      const request = vi.fn()
      render(<Transcript markdown="See `src/app.ts`." request={request} />)

      clickLink('src/app.ts')

      expect(request).not.toHaveBeenCalled()
      expect(mocks.openDetectedFilePath).toHaveBeenCalledTimes(opens)
    })
  })
})

import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import '@/assets/main.css'
import { installWebPreloadApi } from '@/web/web-preload-api'
import { Button } from '@/components/ui/button'
import { TooltipProvider } from '@/components/ui/tooltip'
import { LinkActionPopover } from '@/components/link-actions/LinkActionPopover'
import type { TerminalLinkActionRequest } from '@/components/terminal-pane/terminal-link-action-request'
import { installTerminalLinkPointerGesture } from '@/components/terminal-pane/terminal-link-pointer-gesture'
import { installTerminalLinkifierClickPriming } from '@/components/terminal-pane/terminal-linkifier-click-priming'
import { installHttpLinkClickFallback } from '@/components/terminal-pane/terminal-url-link-hit-testing'
import { installTerminalPaneTouchLinks } from '@/components/terminal-pane/terminal-pane-touch-links'
import { createFilePathLinkProvider } from '@/components/terminal-pane/terminal-link-handlers'
import { handleOscLink } from '@/components/terminal-pane/terminal-osc-link-routing'
import type { LinkHandlerDeps } from '@/components/terminal-pane/terminal-link-handlers'

installWebPreloadApi()
const { useAppStore } = await import('@/store')
const { default: MarkdownPreview } = await import('@/components/editor/MarkdownPreview')
const destination = new URL('./destination.html', location.href).href
useAppStore.setState({
  settings: { ...useAppStore.getState().settings!, openLinksInApp: false },
  repos: [{ id: 'repo', path: '/repo', displayName: 'Fixture', badgeColor: '', addedAt: 0 }],
  worktreesByRepo: {
    repo: [
      {
        id: 'wt',
        repoId: 'repo',
        path: '/repo',
        head: 'abc',
        branch: 'main',
        isBare: false,
        isMainWorktree: true,
        displayName: 'Fixture',
        comment: '',
        linkedIssue: null,
        linkedPR: null,
        linkedLinearIssue: null,
        linkedGitLabMR: null,
        linkedGitLabIssue: null,
        isArchived: false,
        isUnread: false,
        isPinned: false,
        sortOrder: 0,
        lastActivityAt: 0,
        workspaceStatus: 'todo',
        diffComments: []
      }
    ]
  }
})
// The fixture replaces filesystem access only; rendered links, gestures and routing stay real.
window.api.shell.pathExists = async () => true

/**
 * Renders a real xterm terminal wired to the pane's actual link routing for browser tests.
 *
 * Only filesystem access is stubbed; gestures, linkifiers and the destination chooser are
 * the shipped components so a test failure means the product path failed.
 */
function Fixture() {
  const host = useRef<HTMLDivElement>(null)
  const [request, setRequest] = useState<TerminalLinkActionRequest | null>(null)
  useEffect(() => {
    const terminal = new Terminal({ cols: 40, rows: 6, fontSize: 14 })
    terminal.open(host.current!)
    const gesture = installTerminalLinkPointerGesture(terminal)
    const getLinkActionContext = () => ({
      paneId: 1,
      pointerGesture: gesture,
      claimPtyMouse: () => true,
      request: setRequest,
      focusTerminal: () => terminal.focus()
    })
    const deps: LinkHandlerDeps = {
      worktreeId: 'wt',
      worktreePath: '/repo',
      startupCwd: '/repo',
      managerRef: {
        current: { getPanes: () => [{ id: 1, terminal }] }
      } as LinkHandlerDeps['managerRef'],
      linkProviderDisposablesRef: { current: new Map() },
      pathExistsCache: new Map(),
      getLinkActionContext
    }
    const disposables = [
      gesture,
      installTerminalLinkifierClickPriming(terminal),
      terminal.registerLinkProvider(
        createFilePathLinkProvider(1, deps, document.createElement('div'), 'Open')
      ),
      installHttpLinkClickFallback(terminal, { worktreeId: 'wt', getLinkActionContext }),
      ...(new URLSearchParams(location.search).has('withoutTouchLinks')
        ? []
        : [
            installTerminalPaneTouchLinks({
              terminal,
              paneId: 1,
              linkDeps: deps,
              getLinkActionContext,
              getSourceOwner: () => ({ kind: 'local' }),
              getActionDestinations: () => ({ primary: 'system', alternate: 'orca' }),
              requestOpenLinksInAppPreference: () => false
            })
          ])
    ]
    terminal.options.linkHandler = {
      activate: (event, text) => {
        handleOscLink(text, event, { ...deps, linkActionContext: getLinkActionContext() })
      }
    }
    terminal.write(
      'https://example.com/tap\r\nREADME.md\r\n\x1b]8;;https://example.com/osc\x07OSC label\x1b]8;;\x07\r\nselectable text\r\n',
      () => {
        ;(window as unknown as { terminal: Terminal }).terminal = terminal
        host.current?.setAttribute('data-ready', 'true')
      }
    )
    return () => {
      disposables.forEach((d) => d.dispose())
      terminal.dispose()
    }
  }, [])
  return (
    <TooltipProvider>
      <div className="flex h-dvh flex-col bg-background text-foreground">
        <div ref={host} data-testid="terminal" className="shrink-0" />
        <Button asChild>
          <a href={destination} target="_blank" rel="noreferrer">
            Card link
          </a>
        </Button>
        <Button onClick={() => void window.api.shell.openUrl(destination)}>External button</Button>
        <MarkdownPreview
          filePath="/repo/README.md"
          sourceWorktreeId="wt"
          scrollCacheKey="touch-fixture"
          content={`# Preview\n\n[Markdown body](${destination})\n\n${destination}\n\n[Internal anchor](#target)\n\n${'Scroll prose.\n\n'.repeat(60)}## Target\n\nDestination`}
        />
        <LinkActionPopover request={request} onClose={() => setRequest(null)} />
      </div>
    </TooltipProvider>
  )
}
createRoot(document.getElementById('root')!).render(<Fixture />)

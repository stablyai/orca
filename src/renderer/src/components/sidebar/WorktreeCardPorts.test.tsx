import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspacePort } from '../../../../shared/workspace-ports'

let settings: { openLinksInApp?: boolean } | null = null

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      createBrowserTab: vi.fn(),
      setRemoteBrowserPageHandle: vi.fn(),
      replaceWorkspacePortScans: vi.fn(),
      setWorkspacePortScanRefreshing: vi.fn(),
      settings
    })
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

const port: WorkspacePort = {
  id: '127.0.0.1:58941:1234',
  bindHost: '127.0.0.1',
  connectHost: '127.0.0.1',
  port: 58941,
  pid: 1234,
  processName: 'node',
  protocol: 'http',
  kind: 'workspace',
  owner: {
    worktreeId: 'repo::/workspace/app',
    repoId: 'repo',
    displayName: 'app',
    path: '/workspace/app',
    confidence: 'cwd'
  },
  advertisedUrl: 'http://dev.preview.localhost:58941'
}

async function renderDetails(): Promise<string> {
  const { WorktreeCardPortsDetails } = await import('./WorktreeCardPorts')
  return renderToStaticMarkup(<WorktreeCardPortsDetails ports={[port]} />)
}

describe('WorktreeCardPortsDetails', () => {
  beforeEach(() => {
    settings = null
  })

  it('shows advertised port addresses in workspace hover details', async () => {
    const markup = await renderDetails()

    expect(markup).toContain('dev.preview.localhost:58941')
    expect(markup).toContain('aria-label="Copy dev.preview.localhost:58941"')
    expect(markup).toContain(
      '<section class="space-y-1.5"><div class="flex items-center gap-1.5 px-1'
    )
    expect(markup).toContain('class="border-l border-border/70 pl-3 space-y-0.5"')
  })

  it('offers no modifier hint when a plain click already opens the system browser', async () => {
    // Link Routing is off by default, so on a local port the plain click and the modifier
    // land in the same place. Advertising a gesture that changes nothing is noise.
    expect(await renderDetails()).not.toContain('click for system browser')
  })

  it('names the system browser once Link Routing sends the plain click into Orca', async () => {
    settings = { openLinksInApp: true }

    expect(await renderDetails()).toContain('Open in Browser. Shift+Ctrl+click for system browser')
  })
})

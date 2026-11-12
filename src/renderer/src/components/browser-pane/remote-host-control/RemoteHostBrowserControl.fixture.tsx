import { useEffect } from 'react'
import { toast } from 'sonner'
import { DndContext } from '@dnd-kit/core'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { Toaster } from '../../ui/sonner'
import TabBar from '../../tab-bar/TabBar'
import { setBrowserAgentPageActive } from '../agent-cursor/browser-agent-activity-state'
import {
  remoteHostBrowserControlNoticeId,
  showRemoteHostBrowserControlNotice
} from './remote-host-browser-control-notice'

const WORKSPACE_ID = 'remote-host-control-fixture'
const HOST_PAGE = 'host-page'
const LOCAL_PAGE = 'local-page'
const noop = (): void => {}

function browserTab(id: string, pageId: string, url: string, title: string) {
  return {
    id,
    worktreeId: WORKSPACE_ID,
    activePageId: pageId,
    pageIds: [pageId],
    url,
    title,
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 0
  }
}

function TabStrip(): React.JSX.Element {
  return (
    <DndContext>
      <div className="@container/tab-strip h-8 bg-card">
        <TabBar
          tabs={[]}
          activeTabId="host-tab"
          activeTabType="browser"
          worktreeId={WORKSPACE_ID}
          groupId="remote-host-control-group"
          browserTabs={[
            browserTab('host-tab', HOST_PAGE, 'http://localhost:3000/', 'Staging dashboard'),
            browserTab('local-tab', LOCAL_PAGE, 'https://example.com/', 'Example Domain')
          ]}
          expandedPaneByTabId={{}}
          showAgentLaunchItems={false}
          onActivate={noop}
          onClose={noop}
          onCloseOthers={noop}
          onCloseToRight={noop}
          onCloseToLeft={noop}
          onNewTerminalTab={noop}
          onNewBrowserTab={noop}
          onSetCustomTitle={noop}
          onSetTabColor={noop}
          onTogglePaneExpand={noop}
        />
      </div>
      <div className="h-24" />
    </DndContext>
  )
}

/** One tab driven by an SSH host, one by a local agent; hovering the host's tab names it. */
export const tabControlledByHost = defineFixture({
  width: 720,
  setup: () => {
    setBrowserAgentPageActive(HOST_PAGE, true, WORKSPACE_ID, 'build-box')
    setBrowserAgentPageActive(LOCAL_PAGE, true, WORKSPACE_ID)
  },
  render: () => <TabStrip />,
  interact: async (frame) => {
    const tab = frame.querySelector<HTMLElement>('[data-tab-id="host-tab"]')
    tab?.focus()
    tab?.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' }))
    await new Promise((resolve) => setTimeout(resolve, 900))
    if (!document.querySelector('[data-tab-hover-card]')?.textContent?.includes('build-box')) {
      throw new Error('The host-driven tab should say which host controls it')
    }
  }
})

function Notice({ canDisallow }: { canDisallow: boolean }): React.JSX.Element {
  useEffect(() => {
    showRemoteHostBrowserControlNotice(
      { targetId: 'ssh-1', hostLabel: 'build-box', canDisallow },
      { stop: async () => {}, disallow: async () => true }
    )
    return () => {
      toast.dismiss(remoteHostBrowserControlNoticeId('ssh-1'))
    }
  }, [canDisallow])
  return (
    <>
      <div className="h-[220px]" />
      <Toaster position="top-left" closeButton toastOptions={{ className: 'font-sans text-sm' }} />
    </>
  )
}

async function toastMounted(): Promise<void> {
  const deadline = performance.now() + 3000
  while (document.querySelector('[data-sonner-toast]')?.getAttribute('data-mounted') !== 'true') {
    if (performance.now() > deadline) {
      throw new Error('Timed out waiting for the notice')
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/** The first time a host drives a tab: non-blocking, with Stop and Don't allow. */
export const firstUseNotice = defineFixture({
  width: 520,
  render: () => <Notice canDisallow />,
  interact: toastMounted
})

/** Hosts Orca created itself keep their setting; only Stop is offered. */
export const firstUseNoticeOrcaOwnedHost = defineFixture({
  width: 520,
  render: () => <Notice canDisallow={false} />,
  interact: toastMounted
})

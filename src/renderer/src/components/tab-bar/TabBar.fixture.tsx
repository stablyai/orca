import { useState } from 'react'
import { DndContext } from '@dnd-kit/core'
import { defineFixture } from '../../component-fixtures/component-fixture'
import type { TerminalTab } from '../../../../shared/workspace-layout/terminal-tab-types'
import TabBar from './TabBar'
import type { TabBarProps } from './tab-bar-props'
import {
  buildBrowserPage,
  buildWorkspaceFromPage
} from '../../store/slices/browser/pages/browser-page-records'

const WORKSPACE_ID = 'tab-width-fixture'
const TITLES = [
  'Should we regenerate the conversation title?',
  'Native chat tab title regeneration',
  'Codex Chat',
  "You're the president agent coordinating this review"
]
const noop = (): void => {}
function TabWidthFixture({
  count,
  titles = TITLES,
  agentTabs = true,
  browserTabs,
  clientHostedBrowserRows,
  editorFiles,
  tabBarOrder,
  initialActiveIndex = 0,
  isGroupFocused
}: {
  count: number
  titles?: string[]
  agentTabs?: boolean
  initialActiveIndex?: number
  isGroupFocused?: boolean
} & Pick<
  TabBarProps,
  'browserTabs' | 'clientHostedBrowserRows' | 'editorFiles' | 'tabBarOrder'
>): React.JSX.Element {
  const [activeTabId, setActiveTabId] = useState(`tab-${initialActiveIndex}`)
  const tabs: TerminalTab[] = Array.from({ length: count }, (_, index) => ({
    id: `tab-${index}`,
    worktreeId: WORKSPACE_ID,
    ptyId: null,
    title: titles[index % titles.length],
    customTitle: null,
    color: null,
    sortOrder: index,
    createdAt: 0,
    launchAgent: agentTabs ? 'codex' : undefined
  }))

  return (
    <DndContext>
      <div className="@container/tab-strip h-8 bg-card">
        <TabBar
          tabs={tabs}
          activeTabId={activeTabId}
          activeTabType="terminal"
          worktreeId={WORKSPACE_ID}
          groupId="tab-width-group"
          isGroupFocused={isGroupFocused}
          browserTabs={browserTabs}
          clientHostedBrowserRows={clientHostedBrowserRows}
          editorFiles={editorFiles}
          tabBarOrder={tabBarOrder}
          expandedPaneByTabId={{}}
          showAgentLaunchItems={false}
          onActivate={setActiveTabId}
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
    </DndContext>
  )
}

export const availableWidth = defineFixture({
  width: 1280,
  render: () => <TabWidthFixture count={4} />
})

export const twoTabs = defineFixture({
  width: 1280,
  render: () => (
    <TabWidthFixture count={2} titles={['Council Branch Review: Zero Regressions', 'Terminal 1']} />
  )
})

export const single = defineFixture({
  width: 1280,
  render: () => <TabWidthFixture count={1} titles={['Terminal 1']} />
})

export const long = defineFixture({
  width: 1280,
  render: () => <TabWidthFixture count={1} titles={['A very long conversation title '.repeat(8)]} />
})

export const narrow = defineFixture({
  width: 420,
  render: () => <TabWidthFixture count={4} />
})

export const overflowing = defineFixture({
  width: 420,
  render: () => <TabWidthFixture count={12} />
})

export const mixedTypes = defineFixture({
  width: 620,
  render: () => (
    <TabWidthFixture
      count={1}
      titles={['A very long conversation title '.repeat(12)]}
      tabBarOrder={['tab-0', 'browser-0', 'file-0']}
      browserTabs={[
        {
          id: 'browser-0',
          worktreeId: WORKSPACE_ID,
          url: 'https://google.com',
          title: 'Google',
          loading: false,
          faviconUrl: null,
          canGoBack: false,
          canGoForward: false,
          loadError: null,
          createdAt: 0
        }
      ]}
      editorFiles={[
        {
          id: 'file-0',
          worktreeId: WORKSPACE_ID,
          filePath: '/tmp/untitled.md',
          relativePath: 'untitled.md',
          language: 'markdown',
          isDirty: true,
          mode: 'edit'
        }
      ]}
    />
  )
})

export const singleBrowser = defineFixture({
  width: 1000,
  render: () => (
    <TabWidthFixture
      count={0}
      browserTabs={[
        {
          id: 'browser-0',
          worktreeId: WORKSPACE_ID,
          url: 'https://example.com',
          title: 'A browser page with a long descriptive title',
          loading: false,
          faviconUrl: null,
          canGoBack: false,
          canGoForward: false,
          loadError: null,
          createdAt: 0
        }
      ]}
    />
  )
})

const audioPreview = buildBrowserPage(
  'audio-preview',
  WORKSPACE_ID,
  '',
  'HTML preview',
  undefined,
  'preview-page',
  { kind: 'workspace-doc', worktreeId: WORKSPACE_ID, filePath: '/docs/audio.html' }
)
const audioBrowser = buildBrowserPage(
  'audio-browser',
  WORKSPACE_ID,
  'https://example.com',
  'Browser page',
  undefined,
  'browser-page'
)

export const documentAudioProtection = defineFixture({
  width: 760,
  store: {
    browserPagesByWorkspace: { 'audio-preview': [audioPreview], 'audio-browser': [audioBrowser] },
    browserAudiblePageIds: { 'browser-page': true },
    browserAudioMutedTabIds: {}
  },
  render: () => (
    <TabWidthFixture
      count={0}
      browserTabs={[
        buildWorkspaceFromPage('audio-preview', WORKSPACE_ID, audioPreview, [audioPreview.id]),
        buildWorkspaceFromPage('audio-browser', WORKSPACE_ID, audioBrowser, [audioBrowser.id])
      ]}
    />
  )
})

export const singleFile = defineFixture({
  width: 1000,
  render: () => (
    <TabWidthFixture
      count={0}
      editorFiles={[
        {
          id: 'file-0',
          worktreeId: WORKSPACE_ID,
          filePath: '/tmp/notes.md',
          relativePath: 'notes.md',
          language: 'markdown',
          isDirty: true,
          mode: 'edit'
        }
      ]}
    />
  )
})

export const singleHostedPage = defineFixture({
  width: 1000,
  render: () => (
    <TabWidthFixture
      count={0}
      clientHostedBrowserRows={[
        {
          browserPageId: 'hosted-0',
          worktreeId: WORKSPACE_ID,
          url: 'https://example.com',
          title: 'A page hosted on a paired device',
          loading: false,
          browserHostClientId: 'client-0',
          hostDeviceName: 'Phone',
          hostAbsent: false
        }
      ]}
    />
  )
})

function NonAgentTabsFixture(): React.JSX.Element {
  return (
    <TabWidthFixture
      count={2}
      titles={['sh', 'A very long terminal title '.repeat(8)]}
      agentTabs={false}
      tabBarOrder={['tab-0', 'browser-0', 'file-0', 'tab-1', 'browser-1', 'file-1']}
      browserTabs={['Example', 'A very long browser page title '.repeat(8)].map((title, index) => ({
        id: `browser-${index}`,
        worktreeId: WORKSPACE_ID,
        url: 'https://example.com',
        title,
        loading: false,
        faviconUrl: null,
        canGoBack: false,
        canGoForward: false,
        loadError: null,
        createdAt: 0
      }))}
      editorFiles={['notes.md', `${'a-long-file-name-'.repeat(8)}.md`].map((name, index) => ({
        id: `file-${index}`,
        worktreeId: WORKSPACE_ID,
        filePath: `/tmp/${name}`,
        relativePath: name,
        language: 'markdown',
        isDirty: false,
        mode: 'edit'
      }))}
      clientHostedBrowserRows={[
        {
          browserPageId: 'hosted-0',
          worktreeId: WORKSPACE_ID,
          url: 'https://example.com',
          title: 'Hosted page',
          loading: false,
          browserHostClientId: 'client-0',
          hostDeviceName: 'Phone',
          hostAbsent: false
        }
      ]}
    />
  )
}

export const nonAgentTabs = defineFixture({
  width: 1800,
  render: () => <NonAgentTabsFixture />
})

export const nonAgentTabsOverflowing = defineFixture({
  width: 420,
  render: () => <NonAgentTabsFixture />
})

export const constrainedFiles = defineFixture({
  width: 590,
  render: () => (
    <TabWidthFixture
      count={0}
      editorFiles={['first', 'second'].map((name, index) => ({
        id: `file-${index}`,
        worktreeId: WORKSPACE_ID,
        filePath: `/tmp/${name}-${'long-name-'.repeat(12)}.md`,
        relativePath: `${name}-${'long-name-'.repeat(12)}.md`,
        language: 'markdown',
        isDirty: false,
        mode: 'edit'
      }))}
    />
  )
})

function AgentIdentityFixture(): React.JSX.Element {
  const [agentTabs, setAgentTabs] = useState(false)
  return (
    <>
      <button onClick={() => setAgentTabs(!agentTabs)}>Toggle agent identity</button>
      <TabWidthFixture count={2} titles={['sh', 'sh']} agentTabs={agentTabs} />
    </>
  )
}

export const agentIdentityChanges = defineFixture({
  width: 900,
  render: () => <AgentIdentityFixture />
})

// Narrow-pane condensing: 6 tabs, the 4th active, at the widths the option-D design walks through.
const NARROW_TITLES = [
  'Build server',
  'Release notes draft',
  'Test runner',
  'API docs review',
  'Migration plan',
  'Shell'
]

function NarrowStripFixture(): React.JSX.Element {
  return <TabWidthFixture count={6} titles={NARROW_TITLES} initialActiveIndex={3} isGroupFocused />
}

function narrowStrip(width: number): ReturnType<typeof defineFixture> {
  return defineFixture({ width, render: () => <NarrowStripFixture /> })
}

export const narrow640 = narrowStrip(640)
export const narrow440 = narrowStrip(440)
export const narrow330 = narrowStrip(330)
export const narrow280 = narrowStrip(280)
export const narrow230 = narrowStrip(230)
export const narrow205 = narrowStrip(205)
export const narrowChipOnly = narrowStrip(120)

async function nextFrames(count: number): Promise<void> {
  for (let index = 0; index < count; index++) {
    await new Promise((resolve) => requestAnimationFrame(resolve))
  }
}

/** Opens the "+N" list and moves keyboard focus one row, so the current row and the focused row differ. */
async function openOverflowList(frame: HTMLElement): Promise<void> {
  await nextFrames(4)
  frame
    .querySelector('[data-tab-strip-overflow-chip]')
    ?.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })
    )
  await new Promise((resolve) => setTimeout(resolve, 300))
  const focused = document.activeElement
  focused?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' }))
  await nextFrames(2)
}

export const narrowOverflowListOpen = defineFixture({
  width: 280,
  render: () => <NarrowStripFixture />,
  interact: openOverflowList
})

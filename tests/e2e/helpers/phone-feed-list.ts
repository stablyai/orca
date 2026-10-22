import { expect } from '@stablyai/playwright-test'
import type { Page } from '@stablyai/playwright-test'
import { buildSidebarFeedRows } from '../../../src/shared/sidebar-list/sidebar-feed-rows'
import { buildSidebarFeedCatalog } from '../../../src/shared/sidebar-list/sidebar-feed-catalog'
import { buildHostFeedView } from '../../../mobile/src/host-screen/host-sidebar-feed-inputs'
import { buildHostFeedSections } from '../../../mobile/src/host-screen/host-sidebar-feed-sections'
import {
  readHostSidebarFeed,
  type HostSidebarFeedRead
} from '../../../mobile/src/host-screen/use-host-sidebar-feed'
import { createHostSidebarFeedReader } from '../../../mobile/src/host-screen/host-sidebar-feed-connection'
import { readHostMethodReply } from '../../../mobile/src/host-screen/host-sidebar-feed-operations'
import {
  hostPlatformRead,
  hostViewSettingsRead
} from '../../../mobile/src/host-screen/host-screen-operations'
import { startHostWorktreeRefresh } from '../../../mobile/src/worktree/host-worktree-refresh'
import {
  INITIAL_MOBILE_VIEW,
  applyDesktopViewSettings,
  type WorkspaceViewSettings
} from '../../../mobile/src/worktree/workspace-view-settings'
import type { RpcResponse } from '../../../mobile/src/transport/types'
import { NODE_PLATFORM_NAMES } from '../../../mobile/src/transport/mobile-runtime-host-platform'
import type { LastVisitedWorktreeOnHost } from '../../../mobile/src/worktree/host-list-highlight'
import type { Section } from '../../../mobile/src/worktree/workspace-list-types'
import type { PairedMobileClient, PairedMobileSocket } from './paired-mobile-client'

/** One line per row the list shows, in order: what the phone and the desktop sidebar must share. */
export type ListOutline = string[]

/** The phone's one socket as the page's request port: each reply as the bridge hands it over. */
function socketPort(socket: PairedMobileSocket) {
  let sequence = 0
  let feedReadGate: Promise<void> | null = null
  let heldFeedReads = 0
  return {
    sendRequest: async (method: string, params?: unknown): Promise<RpcResponse> => {
      sequence += 1
      const id = `phone-list-${sequence}`
      socket.send(id, method, params ?? null)
      await expect
        .poll(() => socket.frames.some((frame) => frame.id === id), { timeout: 30_000 })
        .toBe(true)
      // The host has answered; a held read reaches the page only on release.
      if (method === 'sidebarInputs.read' && feedReadGate) {
        heldFeedReads += 1
        await feedReadGate
      }
      const frame = socket.frames.find((candidate) => candidate.id === id)
      return frame?.ok
        ? { id, ok: true, result: frame.result }
        : { id, ok: false, error: { code: frame?.error?.code ?? 'unknown', message: '' } }
    },
    /** Holds feed replies the host has answered; `held` counts those waiting. */
    holdFeedReads: () => {
      let release = (): void => {}
      heldFeedReads = 0
      feedReadGate = new Promise((resolve) => {
        release = () => {
          feedReadGate = null
          resolve()
        }
      })
      return { release, held: () => heldFeedReads }
    }
  }
}

/** The socket's client-event stream as the page's client subscribes to it, frames in order. */
function socketEventClient(socket: PairedMobileSocket) {
  return {
    subscribe: (method: string, params: unknown, onData: (payload: unknown) => void) => {
      const id = 'phone-list-events'
      socket.send(id, method, params)
      let seen = 0
      const pump = setInterval(() => {
        for (const frame of socket.frames.slice(seen)) {
          if (frame.id === id) {
            onData(frame.result)
          }
        }
        seen = socket.frames.length
      }, 20)
      return () => clearInterval(pump)
    }
  }
}

/**
 * The phone page's workspace list over a real paired socket, built by the page's own modules: its
 * refresh lifecycle, feed reader, the shared builder and its section mapping. Reads happen only
 * when that lifecycle makes them; an assertion reads what the page last installed.
 */
export async function openPhoneFeedList(
  phone: PairedMobileClient,
  /** The workspace this phone last opened on the host: its list's only highlight. */
  lastVisited: LastVisitedWorktreeOnHost | null = null
) {
  const socket = await phone.openSocket()
  const port = socketPort(socket)
  let read: HostSidebarFeedRead = { snapshot: null, unavailable: false }
  const installListeners = new Set<() => void>()
  const reader = createHostSidebarFeedReader(port, ({ snapshot, unavailable }) => {
    const installed = snapshot !== null && snapshot !== read.snapshot
    read = { snapshot, unavailable }
    if (installed) {
      installListeners.forEach((listener) => listener())
    }
  })
  let view = INITIAL_MOBILE_VIEW
  // As use-host-view-settings reads ui.get: at start and on the lifecycle's workspaceViewChanged.
  const syncViewSettings = async (): Promise<void> => {
    const uiRead = readHostMethodReply(
      await port.sendRequest('ui.get'),
      hostViewSettingsRead.interpret
    )
    if (uiRead.kind === 'answered') {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the page reads ui.get the same way (use-host-view-settings.ts).
      view = applyDesktopViewSettings(INITIAL_MOBILE_VIEW, uiRead.value as WorkspaceViewSettings)
    }
  }
  const platformRead = readHostMethodReply(
    await port.sendRequest('host.platform'),
    hostPlatformRead.interpret
  )
  const answered = platformRead.kind === 'answered' ? platformRead.value : null
  // Why matched, not read: this helper and the page may resolve different zod copies, so the
  // reply's inferred type does not carry across.
  const hostPlatform = NODE_PLATFORM_NAMES.find((name) => name === answered) ?? null
  await syncViewSettings()
  const stop = startHostWorktreeRefresh({
    client: socketEventClient(socket),
    // The list reads rows and catalog from the feed alone; worktree.ps adds only card content.
    fetchWorktrees: async () => {},
    fetchRepoMetadata: async () => {},
    syncViewSettings,
    sidebarFeed: {
      refresh: () => reader.refresh(),
      changed: (notice) => reader.changed(notice),
      onInstalled: (listener) => {
        installListeners.add(listener)
        return () => installListeners.delete(listener)
      }
    },
    appState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) }
  })

  /** The sections the page draws; null until the feed installs. */
  const sections = async (): Promise<Section[] | null> => {
    const feed = readHostSidebarFeed(read)
    if (feed.kind !== 'ready') {
      return null
    }
    const { projectCatalog } = feed.domains
    const built = buildSidebarFeedRows(
      feed.domains,
      buildSidebarFeedCatalog(projectCatalog, [], []),
      buildHostFeedView({
        view,
        projectOrderBy: view.projectOrderBy ?? projectCatalog?.projectOrderBy ?? 'manual',
        desktop: feed.domains.desktop,
        hostPlatform
      })
    )
    return buildHostFeedSections({
      rows: built.sectionRows,
      lastVisited,
      liveRows: [],
      repoHostIdByRepoId: new Map(),
      search: ''
    })
  }

  const outline = async (): Promise<ListOutline> =>
    (await sections())?.flatMap((section) => [
      // Titles only: the desktop draws a header's count on hover, not in its text.
      `HEADER ${section.title}`,
      ...section.data.map((row) => `ITEM ${row.sectionListKey}${row.isActive ? ' ACTIVE' : ''}`)
    ]) ?? [readHostSidebarFeed(read).kind]

  return {
    sections,
    outline,
    /** The page's feed reader and its replies, for asserting what the page installed. */
    feed: () => readHostSidebarFeed(read),
    request: port.sendRequest,
    /** Holds the feed's replies the host has answered until `release` runs. */
    holdFeedReads: port.holdFeedReads,
    close: () => {
      stop()
      reader.dispose()
      socket.close()
    }
  }
}

/** An outline without its highlight marks: the phone highlights its own last-opened workspace. */
export function outlineRows(outline: ListOutline): ListOutline {
  return outline.map((line) => line.replace(/ ACTIVE$/, ''))
}

/** The rows the desktop sidebar has rendered, in order, in the outline's terms. */
export async function desktopSidebarOutline(page: Page): Promise<ListOutline> {
  return page.evaluate(() => {
    const prefix = 'worktree-list-option-'
    const rows = [...document.querySelectorAll<HTMLElement>('[data-worktree-virtual-row]')].sort(
      (a, b) => Number(a.dataset.index ?? 0) - Number(b.dataset.index ?? 0)
    )
    return rows.flatMap((row) =>
      // A row element can itself be the option (item rows) or hold it (headers).
      [row, ...row.querySelectorAll<HTMLElement>('[id]')]
        .filter((node) => node.id.startsWith(prefix))
        .map((option) => {
          if (option.getAttribute('role') === 'option') {
            // A folder row's id is its host identity; its list key is the virtual row key.
            const virtualKey = option.dataset.worktreeVirtualRowKey
            const key = virtualKey?.startsWith('folder-workspace:')
              ? virtualKey
              : decodeURIComponent(option.id.slice(prefix.length))
            return `ITEM ${key}${option.getAttribute('aria-current') === 'page' ? ' ACTIVE' : ''}`
          }
          const text = (option.innerText || option.textContent || '').replace(/\s+/g, ' ').trim()
          return `HEADER ${text}`
        })
    )
  })
}

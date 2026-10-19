import { expect } from '@stablyai/playwright-test'
import type { Page } from '@stablyai/playwright-test'
import { buildSidebarFeedRows } from '../../../src/shared/sidebar-list/sidebar-feed-rows'
import {
  HostSidebarFeedReader,
  type HostSidebarFeedRead
} from '../../../mobile/src/host-screen/host-sidebar-feed-reader'
import {
  buildHostFeedCatalog,
  buildHostFeedView
} from '../../../mobile/src/host-screen/host-sidebar-feed-inputs'
import { buildHostFeedSections } from '../../../mobile/src/host-screen/host-sidebar-feed-sections'
import { readHostSidebarFeed } from '../../../mobile/src/host-screen/use-host-sidebar-feed'
import { readHostMethodReply } from '../../../mobile/src/host-screen/host-sidebar-feed-operations'
import {
  hostPlatformRead,
  hostViewSettingsRead
} from '../../../mobile/src/host-screen/host-screen-operations'
import { readServedProjectSections } from '../../../mobile/src/worktree/project-sections-operations'
import {
  INITIAL_MOBILE_VIEW,
  applyDesktopViewSettings,
  type WorkspaceViewSettings
} from '../../../mobile/src/worktree/workspace-view-settings'
import type { RpcResponse } from '../../../mobile/src/transport/types'
import type { Section } from '../../../mobile/src/worktree/workspace-list-types'
import type { PairedMobileClient, PairedMobileSocket } from './paired-mobile-client'

/** One line per row the list shows, in order: what the phone and the desktop sidebar must share. */
export type ListOutline = string[]

function isChangeNotice(
  result: unknown
): result is { type: 'sidebarInputsChanged'; generation: string; revision: number } {
  return (
    typeof result === 'object' &&
    result !== null &&
    'type' in result &&
    result.type === 'sidebarInputsChanged' &&
    'generation' in result &&
    typeof result.generation === 'string' &&
    'revision' in result &&
    typeof result.revision === 'number'
  )
}

/** The phone's one socket as the page's request port: each reply as the bridge hands it over. */
function socketPort(socket: PairedMobileSocket) {
  let sequence = 0
  return {
    sendRequest: async (method: string, params?: unknown): Promise<RpcResponse> => {
      sequence += 1
      const id = `phone-list-${sequence}`
      socket.send(id, method, params ?? null)
      await expect
        .poll(() => socket.frames.some((frame) => frame.id === id), { timeout: 30_000 })
        .toBe(true)
      const frame = socket.frames.find((candidate) => candidate.id === id)
      return frame?.ok
        ? { id, ok: true, result: frame.result }
        : { id, ok: false, error: { code: frame?.error?.code ?? 'unknown', message: '' } }
    }
  }
}

/**
 * The phone page's workspace list over a real paired socket, built by the page's own modules: its
 * feed reader, the shared builder and its section mapping, from the reads the page makes.
 */
export async function openPhoneFeedList(phone: PairedMobileClient) {
  const socket = await phone.openSocket()
  socket.send('phone-list-events', 'runtime.clientEvents.subscribe', null)
  const port = socketPort(socket)
  let read: HostSidebarFeedRead = { installed: null, unavailable: false }
  const reader = new HostSidebarFeedReader(port, (next) => (read = next))
  let framesSeen = 0
  reader.refresh()

  const forwardNotices = (): void => {
    for (const frame of socket.frames.slice(framesSeen)) {
      if (isChangeNotice(frame.result)) {
        reader.changed(frame.result)
      }
    }
    framesSeen = socket.frames.length
  }

  /** The sections the page draws; null until the feed installs. */
  const sections = async (): Promise<Section[] | null> => {
    forwardNotices()
    const feed = readHostSidebarFeed(read)
    if (feed.kind !== 'ready') {
      return null
    }
    const [ui, served, platform] = await Promise.all(
      ['ui.get', 'mobileRelay.projectSections', 'host.platform'].map((method) =>
        port.sendRequest(method)
      )
    )
    const uiRead = readHostMethodReply(ui, hostViewSettingsRead.interpret)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the page reads ui.get the same way (use-host-view-settings.ts).
    const uiValue = (uiRead.kind === 'answered' ? uiRead.value : {}) as WorkspaceViewSettings
    const view = applyDesktopViewSettings(INITIAL_MOBILE_VIEW, uiValue)
    const sections = readServedProjectSections(served)
    const platformRead = readHostMethodReply(platform, hostPlatformRead.interpret)
    const servedValue = sections.kind === 'answered' ? sections.value : null
    const built = buildSidebarFeedRows(
      feed.domains,
      buildHostFeedCatalog(servedValue, [], []),
      buildHostFeedView({
        view,
        projectOrderBy: view.projectOrderBy ?? servedValue?.projectOrderBy ?? 'manual',
        desktop: feed.domains.desktop,
        hostPlatform: platformRead.kind === 'answered' ? platformRead.value : null
      })
    )
    return buildHostFeedSections({
      rows: built.sectionRows,
      activeRowKeys: built.activeRowKeys,
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
    close: () => {
      reader.dispose()
      socket.close()
    }
  }
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

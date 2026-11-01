// Browser pages/session profile are records; host-reported addresses and titles are facts rather than layout.

import { applied, refuse, type Applied } from './workspace-layout-command-steps'
import type { CommandOf } from './workspace-layout-command-types'
import { holdsBrowserPage } from './workspace-layout-content-commands'
import type { LayoutBrowserTab, WorkspaceLayoutModel } from './workspace-layout-model'
import { withWorkspace } from './workspace-layout-removal'

/** Repeated page opens are idempotent; refuse pages held by another tab. */
export function openBrowserPage(
  model: WorkspaceLayoutModel,
  command: CommandOf<'openBrowserPage'>
): Applied {
  return withPageIds(model, command, (pageIds) =>
    pageIds.includes(command.pageId)
      ? pageIds
      : holdsBrowserPage(model, command.pageId)
        ? 'page_exists'
        : [...pageIds, command.pageId]
  )
}

export function closeBrowserPage(
  model: WorkspaceLayoutModel,
  command: CommandOf<'closeBrowserPage'>
): Applied {
  return withPageIds(model, command, (pageIds) => pageIds.filter((id) => id !== command.pageId))
}

export function replaceBrowserPage(
  model: WorkspaceLayoutModel,
  command: CommandOf<'replaceBrowserPage'>
): Applied {
  return withPageIds(model, command, (pageIds) => {
    if (pageIds.includes(command.newPageId)) {
      return pageIds
    }
    if (holdsBrowserPage(model, command.newPageId)) {
      return 'page_exists'
    }
    return pageIds.includes(command.pageId)
      ? pageIds.map((id) => (id === command.pageId ? command.newPageId : id))
      : [...pageIds, command.newPageId]
  })
}

export function setBrowserTabProfile(
  model: WorkspaceLayoutModel,
  command: CommandOf<'setBrowserTabProfile'>
): Applied {
  return withRecord(model, command, (record) => ({
    ...record,
    sessionProfileId: command.profileId,
    sessionPartition: command.sessionPartition
  }))
}

function withPageIds(
  model: WorkspaceLayoutModel,
  command: { workspace: string; browserTabId: string },
  change: (pageIds: string[]) => string[] | 'page_exists'
): Applied {
  return withRecord(model, command, (record) => {
    const pageIds = change(record.pageIds ?? [])
    return pageIds === 'page_exists' ? pageIds : { ...record, pageIds }
  })
}

function withRecord(
  model: WorkspaceLayoutModel,
  command: { workspace: string; browserTabId: string },
  change: (record: LayoutBrowserTab) => LayoutBrowserTab | 'page_exists'
): Applied {
  const workspace = model.workspaces[command.workspace]!
  const records = workspace.browserTabs ?? []
  const record = records.find((entry) => entry.id === command.browserTabId)
  if (!record) {
    return refuse('tab_not_found')
  }
  const next = change(record)
  if (next === 'page_exists') {
    return refuse(next)
  }
  return applied(
    withWorkspace(model, command.workspace, {
      ...workspace,
      browserTabs: records.map((entry) => (entry === record ? next : entry))
    }),
    { tabId: command.browserTabId }
  )
}

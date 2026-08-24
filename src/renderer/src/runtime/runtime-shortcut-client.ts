import type {
  ShortcutComment,
  ShortcutConnectionStatus,
  ShortcutCreateStoryArgs,
  ShortcutCreateStoryResult,
  ShortcutMember,
  ShortcutMutationResult,
  ShortcutStory,
  ShortcutStoryFilter,
  ShortcutStoryUpdate,
  ShortcutTeam,
  ShortcutViewer,
  ShortcutWorkflow,
  ShortcutWorkspaceSelection
} from '../../../shared/shortcut-types'
import { searchLocalShortcutStories } from './local-shortcut-search-cancellation'
import { callRuntimeRpc } from './runtime-rpc-client'
import { isRuntimeProviderSearchQueryWithinLimit } from './runtime-provider-search-bounds'
import { getShortcutRuntimeTarget, type RuntimeShortcutSettings } from './runtime-shortcut-target'

export type { RuntimeShortcutSettings } from './runtime-shortcut-target'

export type ShortcutConnectResult =
  | { ok: true; viewer: ShortcutViewer }
  | { ok: false; error: string }
export type ShortcutCommentResult = { ok: true; id: string } | { ok: false; error: string }

export async function shortcutStatus(
  settings: RuntimeShortcutSettings
): Promise<ShortcutConnectionStatus> {
  const target = getShortcutRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<ShortcutConnectionStatus>(target, 'shortcut.status', undefined, {
        timeoutMs: 15_000
      })
    : window.api.shortcut.status()
}

export async function shortcutReadStatus(
  settings: RuntimeShortcutSettings
): Promise<ShortcutConnectionStatus> {
  const target = getShortcutRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<ShortcutConnectionStatus>(target, 'shortcut.readStatus', undefined, {
        timeoutMs: 15_000
      })
    : window.api.shortcut.readStatus()
}

export async function shortcutConnect(
  settings: RuntimeShortcutSettings,
  args: { apiToken: string }
): Promise<ShortcutConnectResult> {
  const target = getShortcutRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<ShortcutConnectResult>(target, 'shortcut.connect', args, {
        timeoutMs: 30_000
      })
    : window.api.shortcut.connect(args)
}

export async function shortcutDisconnect(
  settings: RuntimeShortcutSettings,
  workspaceId?: string | null
): Promise<void> {
  const target = getShortcutRuntimeTarget(settings)
  if (target.kind === 'environment') {
    await callRuntimeRpc<{ ok: true }>(
      target,
      'shortcut.disconnect',
      workspaceId ? { workspaceId } : undefined,
      { timeoutMs: 15_000 }
    )
    return
  }
  await window.api.shortcut.disconnect(workspaceId ? { workspaceId } : undefined)
}

export async function shortcutSelectWorkspace(
  settings: RuntimeShortcutSettings,
  workspaceId: ShortcutWorkspaceSelection
): Promise<ShortcutConnectionStatus> {
  const target = getShortcutRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<ShortcutConnectionStatus>(
        target,
        'shortcut.selectWorkspace',
        { workspaceId },
        { timeoutMs: 15_000 }
      )
    : window.api.shortcut.selectWorkspace({ workspaceId })
}

export async function shortcutTestConnection(
  settings: RuntimeShortcutSettings,
  workspaceId?: string | null
): Promise<ShortcutConnectResult> {
  const target = getShortcutRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<ShortcutConnectResult>(
        target,
        'shortcut.testConnection',
        workspaceId ? { workspaceId } : undefined,
        { timeoutMs: 30_000 }
      )
    : window.api.shortcut.testConnection(workspaceId ? { workspaceId } : undefined)
}

export async function shortcutSearchStories(
  settings: RuntimeShortcutSettings,
  query: string,
  limit?: number,
  workspaceId?: ShortcutWorkspaceSelection | null,
  signal?: AbortSignal
): Promise<ShortcutStory[]> {
  if (!isRuntimeProviderSearchQueryWithinLimit(query)) {
    return []
  }
  const target = getShortcutRuntimeTarget(settings)
  const args = { query, limit, workspaceId: workspaceId ?? undefined }
  if (target.kind === 'environment') {
    return callRuntimeRpc<ShortcutStory[]>(target, 'shortcut.searchStories', args, {
      timeoutMs: 30_000,
      signal
    })
  }
  return signal ? searchLocalShortcutStories(args, signal) : window.api.shortcut.searchStories(args)
}

export async function shortcutListStories(
  settings: RuntimeShortcutSettings,
  filter?: ShortcutStoryFilter,
  limit?: number,
  workspaceId?: ShortcutWorkspaceSelection | null
): Promise<ShortcutStory[]> {
  const target = getShortcutRuntimeTarget(settings)
  const args = { filter, limit, workspaceId: workspaceId ?? undefined }
  return target.kind === 'environment'
    ? callRuntimeRpc<ShortcutStory[]>(target, 'shortcut.listStories', args, { timeoutMs: 30_000 })
    : window.api.shortcut.listStories(args)
}

export async function shortcutGetStory(
  settings: RuntimeShortcutSettings,
  storyId: string,
  workspaceId?: string | null
): Promise<ShortcutStory | null> {
  const target = getShortcutRuntimeTarget(settings)
  const args = { storyId, workspaceId: workspaceId ?? undefined }
  return target.kind === 'environment'
    ? callRuntimeRpc<ShortcutStory | null>(target, 'shortcut.getStory', args, {
        timeoutMs: 30_000
      })
    : window.api.shortcut.getStory(args)
}

export async function shortcutCreateStory(
  settings: RuntimeShortcutSettings,
  args: ShortcutCreateStoryArgs
): Promise<ShortcutCreateStoryResult> {
  const target = getShortcutRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<ShortcutCreateStoryResult>(target, 'shortcut.createStory', args, {
        timeoutMs: 30_000
      })
    : window.api.shortcut.createStory(args)
}

export async function shortcutUpdateStory(
  settings: RuntimeShortcutSettings,
  storyId: string,
  updates: ShortcutStoryUpdate,
  workspaceId?: string | null
): Promise<ShortcutMutationResult> {
  const target = getShortcutRuntimeTarget(settings)
  const args = { storyId, updates, workspaceId: workspaceId ?? undefined }
  return target.kind === 'environment'
    ? callRuntimeRpc<ShortcutMutationResult>(target, 'shortcut.updateStory', args, {
        timeoutMs: 30_000
      })
    : window.api.shortcut.updateStory(args)
}

export async function shortcutAddStoryComment(
  settings: RuntimeShortcutSettings,
  storyId: string,
  body: string,
  workspaceId?: string | null
): Promise<ShortcutCommentResult> {
  const target = getShortcutRuntimeTarget(settings)
  const args = { storyId, body, workspaceId: workspaceId ?? undefined }
  return target.kind === 'environment'
    ? callRuntimeRpc<ShortcutCommentResult>(target, 'shortcut.addStoryComment', args, {
        timeoutMs: 30_000
      })
    : window.api.shortcut.addStoryComment(args)
}

export async function shortcutStoryComments(
  settings: RuntimeShortcutSettings,
  storyId: string,
  workspaceId?: string | null
): Promise<ShortcutComment[]> {
  const target = getShortcutRuntimeTarget(settings)
  const args = { storyId, workspaceId: workspaceId ?? undefined }
  return target.kind === 'environment'
    ? callRuntimeRpc<ShortcutComment[]>(target, 'shortcut.storyComments', args, {
        timeoutMs: 30_000
      })
    : window.api.shortcut.storyComments(args)
}

export async function shortcutListTeams(
  settings: RuntimeShortcutSettings,
  workspaceId?: ShortcutWorkspaceSelection | null
): Promise<ShortcutTeam[]> {
  const target = getShortcutRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<ShortcutTeam[]>(
        target,
        'shortcut.listTeams',
        workspaceId ? { workspaceId } : undefined,
        { timeoutMs: 30_000 }
      )
    : window.api.shortcut.listTeams(workspaceId ? { workspaceId } : undefined)
}

export async function shortcutListWorkflows(
  settings: RuntimeShortcutSettings,
  workspaceId?: string | null
): Promise<ShortcutWorkflow[]> {
  const target = getShortcutRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<ShortcutWorkflow[]>(
        target,
        'shortcut.listWorkflows',
        workspaceId ? { workspaceId } : undefined,
        { timeoutMs: 30_000 }
      )
    : window.api.shortcut.listWorkflows(workspaceId ? { workspaceId } : undefined)
}

export async function shortcutListMembers(
  settings: RuntimeShortcutSettings,
  workspaceId?: string | null
): Promise<ShortcutMember[]> {
  const target = getShortcutRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<ShortcutMember[]>(
        target,
        'shortcut.listMembers',
        workspaceId ? { workspaceId } : undefined,
        { timeoutMs: 30_000 }
      )
    : window.api.shortcut.listMembers(workspaceId ? { workspaceId } : undefined)
}

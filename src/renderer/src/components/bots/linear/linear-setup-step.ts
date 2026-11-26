// Which screen Linear setup shows, from the cloud's state, the connect trip and the owner's choices.
import type { BotLinearView } from '@/lib/bot-linear-state'
import type { ConnectorConnectView } from '@/lib/connector-connect-state'
import type { BotLinear } from '../../../../../shared/bot-types'
import type { ConnectorLinearWorkspace } from '../../../../../shared/connector-bot-linear-contract'

/** Each step follows from the cloud's state, the connect trip and the owner's choices. */
export type BotLinearSetupStep =
  | { kind: 'checking' }
  | { kind: 'failed'; code: string }
  /** Not linked: one trip signs in and picks the workspace. */
  | { kind: 'connect'; error: string | null }
  /** Linked in several workspaces the bot is not in: the owner picks one, or adds another. */
  | { kind: 'pick'; workspaces: ConnectorLinearWorkspace[] }
  | { kind: 'waiting' }
  /** Linked, but no admin has installed Orca in the workspace yet. */
  | { kind: 'needs-admin'; workspace: ConnectorLinearWorkspace; installUrl: string }
  | { kind: 'turn-on'; workspace: ConnectorLinearWorkspace }
  | { kind: 'done' }

export function botLinearSetupStep(
  view: BotLinearView,
  connect: ConnectorConnectView,
  /** `taken`: workspaces the bot is already in, never picked for it as the only one linked. */
  choice: { workspaceId: string | null; done: boolean; taken?: readonly string[] }
): BotLinearSetupStep {
  if (choice.done) {
    return { kind: 'done' }
  }
  if (connect.status === 'waiting') {
    return { kind: 'waiting' }
  }
  if (view.status === 'loading') {
    return { kind: 'checking' }
  }
  if (view.status !== 'ready') {
    return { kind: 'failed', code: view.status === 'off' ? 'linear_off' : view.error }
  }
  const { workspaces, installUrl } = view.linear
  // The trip's workspace first, then the bot's own, then the only one linked.
  const wanted = connect.status === 'linked' ? connect.link.workspace?.id : choice.workspaceId
  const open = workspaces.filter((entry) => !choice.taken?.includes(entry.workspaceId))
  const workspace =
    workspaces.find((entry) => entry.workspaceId === wanted) ?? (open.length === 1 ? open[0] : null)
  if (!workspace) {
    return open.length > 1
      ? { kind: 'pick', workspaces: open }
      : { kind: 'connect', error: connect.status === 'failed' ? connect.error : null }
  }
  return workspace.installed
    ? { kind: 'turn-on', workspace }
    : { kind: 'needs-admin', workspace, installUrl }
}

/** The bot's Linear workspaces with `workspace` turned on: it keeps its place, or a new one goes last. */
export function withLinearWorkspace(
  current: readonly BotLinear[],
  workspace: ConnectorLinearWorkspace
): BotLinear[] {
  const turnedOn = {
    workspaceId: workspace.workspaceId,
    workspaceName: workspace.name,
    urlKey: workspace.urlKey
  }
  const kept = current.filter((entry) => entry.workspaceId !== workspace.workspaceId)
  const at = current.findIndex((entry) => entry.workspaceId === workspace.workspaceId)
  return at === -1 ? [...kept, turnedOn] : kept.toSpliced(at, 0, turnedOn)
}

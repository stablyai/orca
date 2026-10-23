import { AgentIcon, getAgentLabel } from '@/lib/agent-catalog'
import { AgentTerminalLaunchButton } from './agent/AgentTerminalLaunchButton'
import { useAgentDetectionTargetForWorktree } from '@/hooks/useAgentDetectionTarget'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { requestNativeChatComposerFocus } from './native-chat/use-native-chat-composer-reveal-focus'
import { useTabAgentMenuLaunch } from './tab-bar/QuickLaunchButton'
import { useNewTabAgentMenuRows } from './tab-bar/use-new-tab-agent-menu-rows'
import {
  chatUnavailableLabel,
  rowId,
  rowLabel,
  rowTitle
} from './tab-bar/tab-agent-row-presentation'
import { Button } from './ui/button'

export function WorkspaceEmptyAgentList({
  worktreeId,
  groupId
}: {
  worktreeId: string
  groupId: string
}): React.JSX.Element {
  const target = useAgentDetectionTargetForWorktree(worktreeId)
  const model = useNewTabAgentMenuRows(worktreeId, true, target)
  const launch = useTabAgentMenuLaunch({
    worktreeId,
    groupId,
    onFocusTerminal: focusTerminalTabSurface,
    onFocusChat: requestNativeChatComposerFocus
  })
  const openSettingsPage = useAppStore((state) => state.openSettingsPage)
  const openSettingsTarget = useAppStore((state) => state.openSettingsTarget)
  const primaryRow =
    model.state === 'settled'
      ? model.rows.find((row) => row.kind !== 'chat-unavailable')
      : undefined

  return (
    <div className="mt-6">
      <h3 className="mb-3 text-sm font-medium">
        {translate('components.WorkspaceEmptyState.startAgent', 'Start an agent')}
      </h3>
      {model.state === 'loading' ? (
        <p role="status" className="text-sm text-muted-foreground">
          {translate('auto.components.tab.bar.QuickLaunchButton.agentsLoading', 'Loading agents')}
        </p>
      ) : model.rows.length === 0 ? (
        <p role="status" className="text-sm text-muted-foreground">
          {model.detection.needsServerUpdate
            ? translate(
                'auto.components.tab.bar.QuickLaunchButton.needsServerUpdate',
                'Update Orca on this server to list this workspace’s agents'
              )
            : model.detection.detectionFailed
              ? translate(
                  'auto.components.tab.bar.QuickLaunchButton.hostUnreachable',
                  'Can’t reach this workspace’s host to list its agents'
                )
              : model.detection.detectedIds?.length
                ? translate(
                    'auto.components.tab.bar.QuickLaunchButton.8dea9b5cdf',
                    'No enabled agents'
                  )
                : translate(
                    'auto.components.tab.bar.QuickLaunchButton.e518f544b1',
                    'No agents detected'
                  )}
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-2 @sm:grid-cols-2">
          {model.rows.map((row) => (
            <div key={rowId(row)} className="min-w-0">
              <div className="flex items-center gap-1">
                <Button
                  variant={row === primaryRow ? 'default' : 'outline'}
                  className="min-w-0 flex-1 justify-start"
                  disabled={row.kind === 'chat-unavailable'}
                  aria-label={
                    row.kind === 'chat-unavailable'
                      ? getAgentLabel(row.agent)
                      : rowTitle(row, getAgentLabel(row.agent))
                  }
                  onClick={() => launch(row)}
                >
                  <AgentIcon agent={row.agent} />
                  <span className="truncate">{rowLabel(row)}</span>
                </Button>
                {row.kind === 'chat' ? (
                  <AgentTerminalLaunchButton
                    tabIndex={0}
                    title={rowTitle({ ...row, kind: 'cli' }, getAgentLabel(row.agent))}
                    className="my-0 size-9 opacity-100 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => launch({ ...row, kind: 'cli' })}
                  />
                ) : null}
              </div>
              {row.kind === 'chat-unavailable' ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  {chatUnavailableLabel(row.reason)}
                </p>
              ) : null}
            </div>
          ))}
        </div>
      )}
      <Button
        variant="link"
        size="sm"
        className="mt-2"
        onClick={() => {
          openSettingsTarget({ pane: 'agents', repoId: null })
          openSettingsPage()
        }}
      >
        {translate('auto.components.tab.bar.QuickLaunchButton.348a04c1ad', 'Agent settings…')}
      </Button>
    </div>
  )
}

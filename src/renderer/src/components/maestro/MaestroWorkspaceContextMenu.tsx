import { FilePlus2, Globe2, TerminalSquare } from 'lucide-react'
import { useMemo } from 'react'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { DEFAULT_DISABLED_TUI_AGENTS } from '../../../../shared/tui-agent-selection'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger
} from '@/components/ui/context-menu'
import { useAgentDetectionTargetForWorktree } from '@/hooks/useAgentDetectionTarget'
import { useDetectedAgents } from '@/hooks/useDetectedAgents'
import type { MaestroWorkspaceCanvasResource } from '@/hooks/useMaestroWorkspaceCanvas'
import type { MaestroWorkspaceWindowPlacement } from './maestro-workspace-window-layout'
import { translate } from '@/i18n/i18n'
import { AgentIcon } from '@/lib/agent-catalog'
import { useAppStore } from '@/store'
import {
  buildTabAgentLaunchOptions,
  orderTabLaunchAgents
} from '@/components/tab-bar/tab-agent-launch-options'
import { maestroWorkspaceMutationKey } from './maestro-workspace-mutation-key'

type MaestroWorkspaceContextMenuProps = {
  resource: MaestroWorkspaceCanvasResource
  workspaceKey: string
  placementFor: (surfaceType: 'terminal' | 'browser' | 'content') => MaestroWorkspaceWindowPlacement
}

export function MaestroWorkspaceContextMenu({
  resource,
  workspaceKey,
  placementFor
}: MaestroWorkspaceContextMenuProps): React.JSX.Element {
  const workspace = parseWorkspaceKey(workspaceKey)
  const worktreeId =
    workspace?.type === 'folder' ? workspace.folderWorkspaceId : (workspace?.worktreeId ?? null)
  const detectionTarget = useAgentDetectionTargetForWorktree(worktreeId)
  const { detectedIds } = useDetectedAgents(detectionTarget)
  const defaultAgent = useAppStore((state) => state.settings?.defaultTuiAgent)
  const disabledAgents = useAppStore(
    (state) => state.settings?.disabledTuiAgents ?? DEFAULT_DISABLED_TUI_AGENTS
  )
  const agentOptions = useMemo(
    () =>
      buildTabAgentLaunchOptions(
        orderTabLaunchAgents(defaultAgent, detectedIds ?? [], disabledAgents)
      ),
    [defaultAgent, detectedIds, disabledAgents]
  )
  const createAtPlacement = (
    surfaceType: 'terminal' | 'browser' | 'content',
    create: (placement: MaestroWorkspaceWindowPlacement) => Promise<void>
  ): void => {
    const placement = placementFor(surfaceType)
    void create(placement)
  }
  const createTerminal = (agent?: TuiAgent): void => {
    createAtPlacement('terminal', (placement) =>
      resource.mutate({
        action: 'create',
        surface_type: 'terminal',
        placement,
        ...(agent ? { agent } : {}),
        idempotency_key: maestroWorkspaceMutationKey(
          agent ? `create-${agent}` : 'create-terminal',
          workspaceKey
        )
      })
    )
  }

  return (
    <ContextMenuContent className="w-52">
      <ContextMenuLabel>
        {translate(
          'auto.components.maestro.MaestroWorkspaceContextMenu.35cc43ca9a',
          'Add to canvas'
        )}
      </ContextMenuLabel>
      <ContextMenuSub>
        <ContextMenuSubTrigger>
          <TerminalSquare />
          {translate('auto.components.maestro.MaestroWorkspaceCanvas.3fbda457b1', 'Terminal')}
        </ContextMenuSubTrigger>
        <ContextMenuSubContent className="w-52">
          <ContextMenuItem onSelect={() => createTerminal()}>
            <TerminalSquare />
            {translate(
              'auto.components.maestro.MaestroWorkspaceContextMenu.7c32f9bd91',
              'Normal shell'
            )}
          </ContextMenuItem>
          <ContextMenuSeparator />
          {agentOptions.length ? (
            agentOptions.map((option) => (
              <ContextMenuItem key={option.agent} onSelect={() => createTerminal(option.agent)}>
                <AgentIcon agent={option.agent} size={14} />
                {option.label}
              </ContextMenuItem>
            ))
          ) : (
            <ContextMenuItem disabled>
              {detectedIds
                ? translate(
                    'auto.components.maestro.MaestroWorkspaceContextMenu.82a26e299b',
                    'No enabled CLIs detected'
                  )
                : translate(
                    'auto.components.maestro.MaestroWorkspaceContextMenu.5efde7c17e',
                    'Detecting installed CLIs…'
                  )}
            </ContextMenuItem>
          )}
        </ContextMenuSubContent>
      </ContextMenuSub>
      <ContextMenuItem
        onSelect={() =>
          createAtPlacement('browser', (placement) =>
            resource.mutate({
              action: 'create',
              surface_type: 'browser',
              placement,
              idempotency_key: maestroWorkspaceMutationKey('create-browser', workspaceKey)
            })
          )
        }
      >
        <Globe2 />
        {translate('auto.components.maestro.MaestroWorkspaceCanvas.85e5a5ca61', 'Browser')}
      </ContextMenuItem>
      <ContextMenuItem
        onSelect={() =>
          createAtPlacement('content', (placement) =>
            resource.mutate({
              action: 'create',
              surface_type: 'content',
              placement,
              title: translate(
                'auto.components.maestro.MaestroWorkspaceContextMenu.c27dd0d722b',
                'New annotation'
              ),
              annotation: { text: '', tone: 'observation' },
              idempotency_key: maestroWorkspaceMutationKey('create-annotation', workspaceKey)
            })
          )
        }
      >
        <FilePlus2 />
        {translate(
          'auto.components.maestro.MaestroWorkspaceContextMenu.c27dd0d722b',
          'New annotation'
        )}
      </ContextMenuItem>
    </ContextMenuContent>
  )
}

import { useEffect, useMemo, useRef } from 'react'
import { Plus } from 'lucide-react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { useAppStore } from '@/store'
import { getRepoHeaderCreateState } from '@/components/sidebar/repo-header-create-state'
import { translate } from '@/i18n/i18n'

const FOLDER_PROJECT_PREFIX = 'folder-workspace:'

export type AgentMapProjectContextMenuRequest = {
  id: number
  projectId: string
  clientX: number
  clientY: number
}

type AgentMapProjectContextMenuProps = {
  request: AgentMapProjectContextMenuRequest
  onOpenChange?: (open: boolean) => void
}

export function AgentMapProjectContextMenu({
  request,
  onOpenChange
}: AgentMapProjectContextMenuProps): React.JSX.Element | null {
  const triggerRef = useRef<HTMLSpanElement>(null)
  const repos = useAppStore((state) => state.repos)
  const projectGroups = useAppStore((state) => state.projectGroups)
  const target = useMemo(() => {
    if (request.projectId.startsWith(FOLDER_PROJECT_PREFIX)) {
      const groupId = request.projectId.slice(FOLDER_PROJECT_PREFIX.length)
      const groups = projectGroups.filter((group) => group.id === groupId)
      return groups.length === 1 ? { kind: 'folder' as const, group: groups[0] } : null
    }
    const owners = repos.filter((repo) => repo.id === request.projectId)
    return owners.length === 1 ? { kind: 'repo' as const, repo: owners[0] } : null
  }, [projectGroups, repos, request.projectId])
  const repo = target?.kind === 'repo' ? target.repo : null
  const sshStatus = useAppStore((state) =>
    repo?.connectionId ? (state.sshConnectionStates.get(repo.connectionId)?.status ?? null) : null
  )
  const openModal = useAppStore((state) => state.openModal)

  useEffect(() => {
    if (!target) {
      onOpenChange?.(false)
      return
    }
    triggerRef.current?.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: request.clientX,
        clientY: request.clientY,
        button: 2
      })
    )
  }, [onOpenChange, request, target])

  if (!target) {
    return null
  }
  const label = target.kind === 'repo' ? target.repo.displayName : target.group.name
  const createState =
    target.kind === 'repo'
      ? getRepoHeaderCreateState({ repo: target.repo, label, sshStatus })
      : {
          disabled: false,
          tooltip: translate(
            'auto.components.sidebar.repo.header.create.state.62e71f2d5d',
            'Create workspace for {{value0}}',
            { value0: label }
          ),
          ariaLabel: translate(
            'auto.components.sidebar.repo.header.create.state.62e71f2d5d',
            'Create workspace for {{value0}}',
            { value0: label }
          )
        }

  return (
    <div className="pointer-events-none absolute inset-0">
      <ContextMenu onOpenChange={onOpenChange}>
        <ContextMenuTrigger asChild>
          <span ref={triggerRef} aria-hidden />
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuLabel>{label}</ContextMenuLabel>
          <ContextMenuItem
            disabled={createState.disabled}
            aria-label={createState.ariaLabel}
            onSelect={() => {
              openModal(
                'new-workspace-composer',
                target.kind === 'repo'
                  ? { initialRepoId: target.repo.id, telemetrySource: 'sidebar' }
                  : { initialProjectGroupId: target.group.id, telemetrySource: 'sidebar' }
              )
            }}
          >
            <Plus />
            {createState.tooltip}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </div>
  )
}

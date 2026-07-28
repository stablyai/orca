import { useCallback, useEffect, useRef, useState } from 'react'
import { Pencil, Trash2, GripVertical } from 'lucide-react'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type {
  Repo,
  TerminalQuickCommand,
  TerminalQuickCommandScope
} from '../../../../shared/types'
import {
  getTerminalQuickCommandBody,
  getTerminalQuickCommandScope,
  isTerminalAgentQuickCommand
} from '../../../../shared/terminal-quick-commands'
import { AgentIcon, getAgentLabel } from '@/lib/agent-catalog'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { RepoBadgeMark } from '../repo/RepoBadgeLabel'
import { getQuickCommandRepoLabel } from './QuickCommandsScopeFilter'

function getScopeLabel(
  scope: TerminalQuickCommandScope,
  repoById: Map<string, Pick<Repo, 'displayName' | 'path' | 'badgeColor'>>
): string {
  if (scope.type === 'global') {
    return 'Global'
  }
  const repo = repoById.get(scope.repoId)
  return repo ? getQuickCommandRepoLabel(repo) : 'Missing project'
}

function QuickCommandRow({
  command,
  repoById,
  onEdit,
  onRemove,
  isSortable
}: {
  command: TerminalQuickCommand
  repoById: Map<string, Pick<Repo, 'displayName' | 'path' | 'badgeColor'>>
  onEdit: (command: TerminalQuickCommand) => void
  onRemove: (command: TerminalQuickCommand) => void
  isSortable: boolean
}): React.JSX.Element {
  const scope = getTerminalQuickCommandScope(command)
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging
  } = useSortable({ id: command.id, disabled: !isSortable })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'flex items-center gap-3 rounded-md border border-border/60 bg-background px-3 py-2 shadow-xs',
        isDragging && 'opacity-50'
      )}
    >
      {isSortable ? (
        <button
          type="button"
          {...attributes}
          {...listeners}
          className="shrink-0 cursor-grab text-muted-foreground hover:text-foreground active:cursor-grabbing"
          aria-label={translate(
            'auto.components.settings.QuickCommandsPane.drag-handle',
            'Drag to reorder'
          )}
        >
          <GripVertical className="size-4" />
        </button>
      ) : null}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <div className="truncate text-sm font-medium">
            {command.label ||
              translate('auto.components.settings.QuickCommandsPane.2bb9e38e93', 'Untitled')}
          </div>
          <Badge variant="outline" className="max-w-44 gap-1.5">
            {scope.type === 'repo' ? (
              <>
                <RepoBadgeMark color={repoById.get(scope.repoId)?.badgeColor} />
                <span className="truncate">{getScopeLabel(scope, repoById)}</span>
              </>
            ) : (
              <span className="truncate">{getScopeLabel(scope, repoById)}</span>
            )}
          </Badge>
        </div>
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-foreground/80">
          {isTerminalAgentQuickCommand(command) ? (
            <span className="shrink-0 text-muted-foreground">
              <AgentIcon agent={command.agent} size={12} />
            </span>
          ) : null}
          <span className={cn('truncate', isTerminalAgentQuickCommand(command) ? '' : 'font-mono')}>
            {isTerminalAgentQuickCommand(command)
              ? `${getAgentLabel(command.agent)}: ${getTerminalQuickCommandBody(command)}`
              : getTerminalQuickCommandBody(command) ||
                translate(
                  'auto.components.settings.QuickCommandsPane.0252ddd578',
                  'No command text'
                )}
          </span>
        </div>
      </div>
      <div className="shrink-0 text-[11px] font-medium text-foreground/75">
        {isTerminalAgentQuickCommand(command)
          ? translate('auto.components.settings.QuickCommandsPane.4ccc63da87', 'Agent')
          : command.appendEnter
            ? translate('auto.components.settings.QuickCommandsPane.9b3e338d62', 'Enter')
            : translate('auto.components.settings.QuickCommandsPane.9fcfc29519', 'Insert')}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={translate(
          'auto.components.settings.QuickCommandsPane.7d90fd5299',
          'Edit {{value0}}',
          {
            value0: command.label || 'quick command'
          }
        )}
        onClick={() => onEdit(command)}
      >
        <Pencil />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={translate(
          'auto.components.settings.QuickCommandsPane.8764c6e9e4',
          'Remove {{value0}}',
          {
            value0: command.label || 'quick command'
          }
        )}
        onClick={() => onRemove(command)}
        className="text-muted-foreground hover:text-destructive"
      >
        <Trash2 />
      </Button>
    </div>
  )
}

export function QuickCommandsList({
  commands,
  visibleCommands,
  repoById,
  onEdit,
  onRemove,
  onReorder
}: {
  commands: TerminalQuickCommand[]
  visibleCommands: TerminalQuickCommand[]
  repoById: Map<string, Pick<Repo, 'displayName' | 'path' | 'badgeColor'>>
  onEdit: (command: TerminalQuickCommand) => void
  onRemove: (command: TerminalQuickCommand) => void
  onReorder?: (orderedIds: string[]) => void
}): React.JSX.Element {
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const isSortable = Boolean(onReorder && visibleCommands.length > 1)

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8
      }
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates
    })
  )

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event
      if (!over || active.id === over.id || !onReorder) {
        return
      }
      const oldIndex = visibleCommands.findIndex((cmd) => cmd.id === active.id)
      const newIndex = visibleCommands.findIndex((cmd) => cmd.id === over.id)
      if (oldIndex === -1 || newIndex === -1) {
        return
      }
      const reordered = arrayMove(visibleCommands, oldIndex, newIndex)
      onReorder(reordered.map((cmd) => cmd.id))
    },
    [onReorder, visibleCommands]
  )

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (focusedIndex === null || !isSortable || !onReorder) {
        return
      }
      const isMac = navigator.userAgent.includes('Mac')
      const useAlt = !isMac
      const useMeta = isMac
      if (
        ((useAlt && !event.altKey) || (useMeta && !event.metaKey)) ||
        (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')
      ) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      const direction = event.key === 'ArrowUp' ? -1 : 1
      const newIndex = focusedIndex + direction
      if (newIndex < 0 || newIndex >= visibleCommands.length) {
        return
      }
      const reordered = arrayMove(visibleCommands, focusedIndex, newIndex)
      onReorder(reordered.map((cmd) => cmd.id))
      setFocusedIndex(newIndex)
    },
    [focusedIndex, isSortable, onReorder, visibleCommands]
  )

  useEffect(() => {
    const list = listRef.current
    if (!list) {
      return
    }
    list.addEventListener('keydown', handleKeyDown, { capture: true })
    return () => list.removeEventListener('keydown', handleKeyDown, { capture: true })
  }, [handleKeyDown])

  return (
    <div className="overflow-hidden rounded-lg border border-border/50 bg-muted/20">
      {visibleCommands.length === 0 ? (
        <div className="px-3 py-6 text-sm text-muted-foreground">
          {commands.length === 0
            ? translate(
                'auto.components.settings.QuickCommandsPane.38d61927e6',
                'No quick commands saved.'
              )
            : translate(
                'auto.components.settings.QuickCommandsPane.3eb9897ab0',
                'No commands in the selected scopes.'
              )}
        </div>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={visibleCommands.map((cmd) => cmd.id)} strategy={verticalListSortingStrategy}>
            <div ref={listRef} className="max-h-[60vh] space-y-2 overflow-y-auto p-2 scrollbar-sleek">
              {visibleCommands.map((command, index) => (
                <div
                  key={command.id}
                  onFocus={() => setFocusedIndex(index)}
                  onBlur={() => setFocusedIndex(null)}
                >
                  <QuickCommandRow
                    command={command}
                    repoById={repoById}
                    onEdit={onEdit}
                    onRemove={onRemove}
                    isSortable={isSortable}
                  />
                </div>
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}
    </div>
  )
}

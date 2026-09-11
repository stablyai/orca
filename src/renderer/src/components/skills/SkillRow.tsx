import { useId, useRef } from 'react'
import { ClipboardCopy, FolderOpen, Info, MoreHorizontal, Share2, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { DiscoveredSkill, SkillProvider } from '../../../../shared/skills'
import { sourceKindLabel } from './skill-display-labels'
import {
  SkillRowContextActions,
  SkillRowDropdownActions,
  type SkillRowAction
} from './SkillRowActions'

const providerLabels: Record<SkillProvider, string> = {
  codex: 'Codex',
  claude: 'Claude',
  'agent-skills': 'Agent Skills'
}

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric'
})

function formatUpdatedAt(value: number | null): string {
  return value
    ? dateFormatter.format(new Date(value))
    : translate('auto.components.skills.SkillRow.updatedUnknown', 'No date')
}

export function SkillRow({
  skill,
  selectionMode,
  selected,
  selectable,
  shareable,
  deletable,
  deleteDisabledReason,
  disabledLabel,
  disabledReason,
  focusable,
  onOpenDetail,
  onSelectionChange,
  onShare,
  onDelete,
  onFocus,
  onKeyDown
}: {
  skill: DiscoveredSkill
  selectionMode: boolean
  selected: boolean
  selectable: boolean
  shareable: boolean
  deletable: boolean
  /** Shown on the `Delete…` item itself, so it reads outside selection mode too. */
  deleteDisabledReason: string | null
  /** Mode-dependent: a delete-ineligible row and a share-ineligible row need
   *  different copy in the same visual slot. */
  disabledLabel: string
  /** Row-specific explanation only; page-wide causes are stated once above the
   *  list instead of once per row. */
  disabledReason: string | null
  focusable: boolean
  onOpenDetail: () => void
  onSelectionChange: (selected: boolean, range: boolean) => void
  onShare: () => void
  onDelete: () => void
  onFocus: () => void
  onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void
}): React.JSX.Element {
  const reasonId = useId()
  // Why: Radix's checkbox callback carries no event, so the modifier has to be
  // captured from the pointer press that produced it.
  const rangeRef = useRef(false)
  const selectionBlocked = selectionMode && !selectable
  const showReason = selectionBlocked && disabledReason !== null

  const revealSkill = async (): Promise<void> => {
    const result = await window.api.shell.openInFileManager(skill.skillFilePath)
    if (!result.ok) {
      toast.error(
        translate('auto.components.skills.SkillsPage.995fde8337', 'Could not reveal skill file')
      )
    }
  }

  const copyPath = async (): Promise<void> => {
    await window.api.ui.writeClipboardText(skill.skillFilePath)
    toast.success(translate('auto.components.skills.SkillRow.pathCopied', 'Path copied'))
  }

  const actions: SkillRowAction[] = [
    {
      key: 'details',
      label: translate('auto.components.skills.SkillRow.viewDetails', 'View details'),
      icon: <Info />,
      onSelect: onOpenDetail
    },
    {
      key: 'share',
      label: translate('auto.components.skills.SkillCard.d25a1b8ae6', 'Share skill'),
      icon: <Share2 />,
      disabled: !shareable,
      onSelect: onShare
    },
    {
      key: 'reveal',
      label: translate('auto.components.skills.SkillsPage.dc4c3328ee', 'Reveal file'),
      icon: <FolderOpen />,
      onSelect: () => void revealSkill()
    },
    {
      key: 'copy-path',
      label: translate('auto.components.skills.SkillRow.copyPath', 'Copy path'),
      icon: <ClipboardCopy />,
      onSelect: () => void copyPath()
    },
    {
      key: 'delete',
      label: translate('auto.components.skills.SkillRow.deleteSkill', 'Delete…'),
      icon: <Trash2 />,
      disabled: !deletable,
      destructive: true,
      ...(deleteDisabledReason ? { disabledReason: deleteDisabledReason } : {}),
      onSelect: onDelete
    }
  ]

  const activate = (): void => {
    if (selectionMode) {
      if (!selectionBlocked) {
        onSelectionChange(!selected, rangeRef.current)
      }
      return
    }
    onOpenDetail()
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          role="option"
          aria-selected={selectionMode ? selected : false}
          aria-describedby={showReason ? reasonId : undefined}
          tabIndex={focusable ? 0 : -1}
          data-skill-row={skill.id}
          onFocus={onFocus}
          onPointerDownCapture={(event) => {
            rangeRef.current = event.shiftKey
          }}
          onClick={activate}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              activate()
              return
            }
            onKeyDown(event)
          }}
          className={cn(
            'group flex w-full cursor-pointer items-start gap-3 border-b border-border/50 px-2 py-2.5 text-left transition-colors last:border-b-0 hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            selected && 'bg-accent',
            selectionBlocked && 'opacity-60'
          )}
        >
          {selectionMode ? (
            <span
              className="mt-0.5 flex shrink-0 items-center"
              onClick={(e) => e.stopPropagation()}
            >
              <Checkbox
                checked={selected}
                disabled={selectionBlocked}
                aria-describedby={showReason ? reasonId : undefined}
                aria-label={translate(
                  'auto.components.skills.SkillCard.01c5a16e01',
                  'Select {{value0}}',
                  { value0: skill.name }
                )}
                onCheckedChange={(value) => onSelectionChange(value === true, rangeRef.current)}
              />
            </span>
          ) : null}
          {/* Why: metadata is its own grid column, so the description truncates
              where that column starts instead of at the window edge. */}
          <div className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3">
            <div className="flex min-w-0 items-baseline gap-2">
              <span className="min-w-0 truncate text-sm font-medium" data-skill-name>
                {skill.name}
              </span>
              {!skill.installed ? (
                <Badge variant="outline" className="h-4 shrink-0 px-1 text-[10px]">
                  {translate('auto.components.skills.SkillsPage.35b9a724a0', 'Available')}
                </Badge>
              ) : null}
              {showReason ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      {disabledLabel}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="top" sideOffset={4}>
                    {disabledReason}
                  </TooltipContent>
                </Tooltip>
              ) : null}
            </div>
            <span className="flex shrink-0 items-center gap-2 text-[11px] text-muted-foreground">
              <span>{sourceKindLabel(skill.sourceKind)}</span>
              <span className="hidden sm:inline" aria-hidden>
                ·
              </span>
              <span className="hidden sm:inline">
                {skill.providers.map((provider) => providerLabels[provider]).join(', ')}
              </span>
              <span aria-hidden>·</span>
              <span className="tabular-nums">{formatUpdatedAt(skill.updatedAt)}</span>
            </span>
            <p className="col-start-1 min-w-0 truncate text-xs leading-5 text-muted-foreground">
              {skill.description ??
                translate('auto.components.skills.SkillsPage.9963dff6d3', 'No description found.')}
            </p>
            {showReason ? (
              <span id={reasonId} className="sr-only">
                {disabledReason}
              </span>
            ) : null}
          </div>
          <div
            className="shrink-0 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 group-focus-visible:opacity-100 has-[[data-state=open]]:opacity-100"
            onClick={(event) => event.stopPropagation()}
          >
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={translate(
                    'auto.components.skills.SkillRow.skillActions',
                    'Actions for {{value0}}',
                    { value0: skill.name }
                  )}
                >
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <SkillRowDropdownActions actions={actions} />
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <SkillRowContextActions actions={actions} />
      </ContextMenuContent>
    </ContextMenu>
  )
}

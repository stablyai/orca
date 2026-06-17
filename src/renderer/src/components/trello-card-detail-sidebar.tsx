import {
  Archive,
  CalendarDays,
  Check,
  ChevronDown,
  List as ListIcon,
  Tag,
  Users
} from 'lucide-react'
import type {
  TrelloCard,
  TrelloLabel,
  TrelloList,
  TrelloMember
} from '../../../shared/trello-types'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { TrelloAvatar } from '@/components/trello-card-detail-avatar'
import { formatShortDate } from '@/components/trello-card-detail-text'

export type TrelloCardDetailActionItem = {
  label: string
  icon: React.ComponentType<{ className?: string }>
  action: () => void
}

type TrelloCardDetailSidebarProps = {
  card: TrelloCard
  listId: string
  lists: TrelloList[]
  boardMembers: TrelloMember[]
  boardLabels: TrelloLabel[]
  saving: boolean
  actionItems: TrelloCardDetailActionItem[]
  onListChange: (listId: string) => void
  onMemberToggle: (memberId: string) => void
  onLabelToggle: (labelId: string) => void
}

export function TrelloCardDetailSidebar({
  card,
  listId,
  lists,
  boardMembers,
  boardLabels,
  saving,
  actionItems,
  onListChange,
  onMemberToggle,
  onLabelToggle
}: TrelloCardDetailSidebarProps): React.JSX.Element {
  return (
    <aside className="space-y-3 lg:sticky lg:top-6 lg:self-start">
      <section className="rounded-xl border border-border/60 bg-card text-card-foreground shadow-xs">
        <div className="flex h-10 items-center gap-1 border-b border-border/50 px-4 text-sm font-medium text-muted-foreground">
          <span>Properties</span>
          <ChevronDown className="size-3.5" />
        </div>
        <div className="space-y-1 p-3">
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="flex min-h-9 w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground transition hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <ListIcon className="size-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate">
                  {lists.find((list) => list.id === listId)?.name ?? card.listName ?? 'List'}
                </span>
                <ChevronDown className="size-3.5 shrink-0" />
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-72 p-2" align="start">
              <div className="text-[10px] font-semibold text-muted-foreground px-2 py-1.5 uppercase tracking-wider">
                List
              </div>
              <div className="max-h-64 overflow-y-auto scrollbar-sleek">
                {lists.map((list) => (
                  <button
                    key={list.id}
                    type="button"
                    onClick={() => onListChange(list.id)}
                    disabled={saving}
                    className="flex min-h-8 w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-70"
                  >
                    <span className="size-2 shrink-0 rounded-full bg-muted-foreground/60" />
                    <span className="min-w-0 flex-1 truncate">{list.name}</span>
                    {list.id === listId ? <Check className="size-3.5" /> : null}
                  </button>
                ))}
              </div>
            </PopoverContent>
          </Popover>

          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="flex min-h-9 w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground transition hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <Users className="size-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate">
                  {card.members.length > 0
                    ? card.members.map((member) => member.fullName || member.username).join(', ')
                    : 'Assignee'}
                </span>
                <ChevronDown className="size-3.5 shrink-0" />
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-72 p-2" align="start">
              <div className="text-[10px] font-semibold text-muted-foreground px-2 py-1.5 uppercase tracking-wider">
                Assignees
              </div>
              <div className="max-h-64 overflow-y-auto scrollbar-sleek">
                {boardMembers.map((member) => {
                  const selected = card.members.some((cardMember) => cardMember.id === member.id)
                  return (
                    <button
                      key={member.id}
                      type="button"
                      onClick={() => onMemberToggle(member.id)}
                      disabled={saving}
                      className="flex min-h-8 w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-70"
                    >
                      <TrelloAvatar
                        avatarUrl={member.avatarUrl}
                        name={member.fullName || member.username}
                        className="size-5"
                      />
                      <span className="min-w-0 flex-1 truncate">
                        {member.fullName || member.username}
                      </span>
                      {selected ? <Check className="size-3.5" /> : null}
                    </button>
                  )
                })}
              </div>
            </PopoverContent>
          </Popover>

          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="flex min-h-9 w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground transition hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <Tag className="size-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate">
                  {card.labels.filter((label) => label.name).length > 0
                    ? card.labels
                        .filter((label) => label.name)
                        .map((label) => label.name)
                        .join(', ')
                    : 'Labels'}
                </span>
                <ChevronDown className="size-3.5 shrink-0" />
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-72 p-2" align="start">
              <div className="text-[10px] font-semibold text-muted-foreground px-2 py-1.5 uppercase tracking-wider">
                Labels
              </div>
              <div className="max-h-64 overflow-y-auto scrollbar-sleek">
                {boardLabels.map((label) => {
                  const selected = card.labels.some((cardLabel) => cardLabel.id === label.id)
                  return (
                    <button
                      key={label.id}
                      type="button"
                      onClick={() => onLabelToggle(label.id)}
                      disabled={saving}
                      className="flex min-h-8 w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-70"
                    >
                      <span className="size-2 shrink-0 rounded-full bg-muted-foreground/60" />
                      <span className="min-w-0 flex-1 truncate">
                        {label.name || label.color || 'Label'}
                      </span>
                      {selected ? <Check className="size-3.5" /> : null}
                    </button>
                  )
                })}
              </div>
            </PopoverContent>
          </Popover>

          <PropertyRow icon={Archive} label="Archived" value={card.closed ? 'Yes' : 'No'} />
          <PropertyRow icon={CalendarDays} label="Due" value={formatShortDate(card.due)} />
        </div>
      </section>

      <section className="rounded-xl border border-border/60 bg-card text-card-foreground shadow-xs">
        <div className="flex h-10 items-center gap-1 border-b border-border/50 px-4 text-sm font-medium text-muted-foreground">
          <span>Actions</span>
          <ChevronDown className="size-3.5" />
        </div>
        <div className="space-y-1 p-3">
          {actionItems.map((item) => {
            const Icon = item.icon
            return (
              <Tooltip key={item.label}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={item.action}
                    className="flex min-h-9 w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground transition hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <Icon className="size-4 shrink-0" />
                    <span className="truncate">{item.label}</span>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="left" sideOffset={6}>
                  {item.label}
                </TooltipContent>
              </Tooltip>
            )
          })}
        </div>
      </section>
    </aside>
  )
}

function PropertyRow({
  icon: Icon,
  label,
  value
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: string
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Icon className="size-3.5" />
        {label}
      </div>
      <span className="truncate text-xs text-foreground">{value}</span>
    </div>
  )
}

import React from 'react'
import { Check, Star } from 'lucide-react'
import { CommandItem } from '@/components/ui/command'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'

type ItemRenderArgs = {
  key: string
  itemValue: string
  isChecked: boolean
  isDefault: boolean
  onSelect: () => void
  onSetDefault?: () => void
  icon: React.ReactNode
  label: string
  disabled?: boolean
  title?: string
  /** After the label: an unavailable row's reason, or a chat row's terminal button. */
  trailing?: React.ReactNode
}

type AgentDefaultContextMenuProps = {
  children: React.ReactNode
  isDefault: boolean
  onSetDefault?: () => void
}

export function AgentIconLabel({
  icon,
  label
}: {
  icon: React.ReactNode
  label: string
}): React.JSX.Element {
  return (
    <span className="inline-flex min-w-0 flex-1 items-center gap-1.5">
      <span className="inline-flex size-3.5 shrink-0 items-center justify-center [&_img]:size-3.5 [&_svg]:size-3.5!">
        {icon}
      </span>
      <span className="truncate leading-none">{label}</span>
    </span>
  )
}

export function AgentDefaultContextMenu({
  children,
  isDefault,
  onSetDefault
}: AgentDefaultContextMenuProps): React.ReactNode {
  if (!onSetDefault) {
    return children
  }
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="z-[70]">
        <ContextMenuItem onSelect={onSetDefault} disabled={isDefault}>
          <Star className="size-3.5" />
          {isDefault
            ? translate('auto.components.agent.AgentCombobox.1b0d6965fa', 'Current default')
            : translate('auto.components.agent.AgentCombobox.9c6b59fe58', 'Set as default')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

export function renderAgentComboboxItem({
  key,
  itemValue,
  isChecked,
  isDefault,
  onSelect,
  onSetDefault,
  icon,
  label,
  disabled,
  title,
  trailing
}: ItemRenderArgs): React.ReactNode {
  const row = (
    <CommandItem
      key={key}
      value={itemValue}
      onSelect={onSelect}
      disabled={disabled}
      title={title}
      className="items-center gap-2 px-3 py-1.5"
    >
      <Check
        className={cn('size-4 shrink-0 text-foreground', isChecked ? 'opacity-100' : 'opacity-0')}
      />
      <AgentIconLabel icon={icon} label={label} />
      {trailing}
    </CommandItem>
  )
  return (
    // Keep the default context menu above the still-open combobox popover (z-70 over z-60).
    <AgentDefaultContextMenu key={key} isDefault={isDefault} onSetDefault={onSetDefault}>
      {row}
    </AgentDefaultContextMenu>
  )
}

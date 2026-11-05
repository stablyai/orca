import { Check } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut
} from '@/components/ui/dropdown-menu'
import type { BrowserChromeFoldStage } from './use-browser-chrome-tool-fold'

export type BrowserChromeFoldedTool = {
  stage: BrowserChromeFoldStage
  label: string
  icon: LucideIcon
  onSelect: () => void
  disabled?: boolean
  shortcut?: string
  count?: number
  /** Present for toggle tools, including false, so the menu preserves their pressed state. */
  active?: boolean
  /** Run after menu close without focus return; focusing the overflow trigger would immediately dismiss a tool’s new popover. */
  deferUntilMenuClose?: boolean
}

export type BrowserChromeOverflowMenuProps = {
  triggerRef: React.RefObject<HTMLButtonElement | null>
  tools: readonly BrowserChromeFoldedTool[]
  deferUntilClose: (action: () => void) => void
  onMenuCloseAutoFocus: (event: Event) => void
}

function FoldedToolContent({ tool }: { tool: BrowserChromeFoldedTool }): React.JSX.Element {
  const showActiveCheck = tool.active === true
  const showTrailing = showActiveCheck || Boolean(tool.count) || Boolean(tool.shortcut)
  return (
    <>
      <tool.icon className="size-3.5" />
      {tool.label}
      {showTrailing ? (
        // Why: a leading check column would push these icon rows out of line with the plain rows.
        <span className="ml-auto flex items-center gap-2">
          {showActiveCheck ? <Check className="size-3.5 text-foreground" /> : null}
          {tool.count ? (
            <span className="flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] leading-4 text-primary-foreground">
              {tool.count}
            </span>
          ) : tool.shortcut ? (
            <DropdownMenuShortcut>{tool.shortcut}</DropdownMenuShortcut>
          ) : null}
        </span>
      ) : null}
    </>
  )
}

function FoldedToolRow({
  tool,
  deferUntilClose
}: {
  tool: BrowserChromeFoldedTool
  deferUntilClose: (action: () => void) => void
}): React.JSX.Element {
  const onSelect = (): void =>
    tool.deferUntilMenuClose ? deferUntilClose(tool.onSelect) : tool.onSelect()
  return (
    <DropdownMenuItem
      disabled={tool.disabled}
      onSelect={onSelect}
      // Preserve checkbox semantics without a reserved check column that would misalign icons.
      {...(tool.active === undefined
        ? {}
        : { role: 'menuitemcheckbox', 'aria-checked': tool.active })}
    >
      <FoldedToolContent tool={tool} />
    </DropdownMenuItem>
  )
}

/** The toolbar tools that no longer fit, rendered at the top of a surface's ⋯ menu. */
export function BrowserChromeFoldedMenuItems({
  tools,
  deferUntilClose
}: Pick<BrowserChromeOverflowMenuProps, 'tools' | 'deferUntilClose'>): React.JSX.Element | null {
  if (tools.length === 0) {
    return null
  }
  // Separate stateful toggles from one-shot actions after tools fold into overflow.
  const toggleTools = tools.filter((tool) => tool.active !== undefined)
  const actionTools = tools.filter((tool) => tool.active === undefined)
  return (
    <>
      {toggleTools.map((tool) => (
        <FoldedToolRow key={tool.stage} tool={tool} deferUntilClose={deferUntilClose} />
      ))}
      {toggleTools.length > 0 && actionTools.length > 0 ? <DropdownMenuSeparator /> : null}
      {actionTools.map((tool) => (
        <FoldedToolRow key={tool.stage} tool={tool} deferUntilClose={deferUntilClose} />
      ))}
      <DropdownMenuSeparator />
    </>
  )
}

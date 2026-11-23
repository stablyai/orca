import { useCallback, useMemo, useRef } from 'react'
import { FolderGit2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ShortcutKeyCombo } from '@/components/ui/ShortcutKeyCombo'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import { getEffectiveKeybindingsForAction } from '../../../../../../shared/keybindings/effective'
import { formatKeybinding } from '../../../../../../shared/keybindings/formatting'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import type { AgentJournalWorkTarget } from '../../../../../../shared/agent-session/work-target/agent-session-work-target'
import { isMacPlatform } from '../../pane/routing/native-chat-shortcut'
import type { BotWorkTargetTreeRow } from './bot-work-target-tree'
import { NativeChatWorkTargetPickerBody } from './NativeChatWorkTargetPickerBody'

export type NativeChatWorkTargetPickerProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  botHostId: ExecutionHostId
  supported: boolean
  disabled?: boolean
  selectedTarget: AgentJournalWorkTarget | null
  onSelectTarget: (target: AgentJournalWorkTarget | null) => void
  focusComposer?: () => void
  /** Pre-built rows override for isolated fixtures and tests. */
  rowsOverride?: readonly BotWorkTargetTreeRow[]
  /** Rendered inside the narrow-composer overflow menu. */
  overflow?: boolean
}

export function NativeChatWorkTargetPicker({
  open,
  onOpenChange,
  botHostId,
  supported,
  disabled = false,
  selectedTarget,
  onSelectTarget,
  focusComposer,
  rowsOverride,
  overflow = false
}: NativeChatWorkTargetPickerProps): React.JSX.Element {
  const t = useTranslate()
  const keybindings = useAppStore((state) => state.keybindings)
  const platform: NodeJS.Platform = isMacPlatform() ? 'darwin' : 'linux'
  const shortcutKeys = useMemo(() => {
    const binding = getEffectiveKeybindingsForAction(
      'chat.pickWorkTarget',
      platform,
      keybindings
    )[0]
    return binding
      ? formatKeybinding(binding, platform)
      : isMacPlatform()
        ? ['⌘', '⇧', 'P']
        : ['Ctrl', 'Shift', 'P']
  }, [keybindings, platform])

  const searchInputRef = useRef<HTMLInputElement>(null)
  const closeAndReturnFocus = useCallback(() => {
    onOpenChange(false)
    requestAnimationFrame(() => focusComposer?.())
  }, [focusComposer, onOpenChange])

  const triggerLabel = t('components.native-chat.workTarget.trigger', 'Target project or workspace')
  const unsupportedNotice = t(
    'components.native-chat.writeNotice.workTargetHostUnsupported',
    'Update Orca on the host running this chat to target a project or workspace.'
  )
  const controlDisabled = disabled || !supported

  if (overflow) {
    return (
      <Button
        type="button"
        variant="disclosure"
        size="menu"
        disabled={controlDisabled}
        title={!supported ? unsupportedNotice : undefined}
        className="w-full justify-between"
        onClick={() => onOpenChange(true)}
      >
        <span className="inline-flex min-w-0 items-center gap-2">
          <FolderGit2 className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate">
            {selectedTarget ? selectedTarget.displayName : triggerLabel}
          </span>
        </span>
        {supported ? <ShortcutKeyCombo keys={shortcutKeys} size="compact" /> : null}
      </Button>
    )
  }

  const triggerButton = (
    <Button
      type="button"
      variant="chat-tool"
      size="icon-sm"
      data-work-target-trigger=""
      aria-label={triggerLabel}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-pressed={selectedTarget !== null}
      disabled={controlDisabled}
      className="pointer-coarse:size-11"
    >
      <FolderGit2 className="size-4" />
    </Button>
  )

  return (
    <Popover
      open={supported ? open : false}
      onOpenChange={(nextOpen) => {
        if (!supported) {
          return
        }
        onOpenChange(nextOpen)
        if (!nextOpen) {
          requestAnimationFrame(() => focusComposer?.())
        }
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          {controlDisabled ? (
            <span className="inline-flex">{triggerButton}</span>
          ) : (
            <PopoverTrigger asChild>{triggerButton}</PopoverTrigger>
          )}
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {!supported ? (
            <span>{unsupportedNotice}</span>
          ) : (
            <span className="flex items-center gap-2">
              <span>{triggerLabel}</span>
              <ShortcutKeyCombo keys={shortcutKeys} size="compact" />
            </span>
          )}
        </TooltipContent>
      </Tooltip>
      <PopoverContent
        align="start"
        side="top"
        sideOffset={8}
        className="w-80"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          searchInputRef.current?.focus()
        }}
        onEscapeKeyDown={(event) => {
          event.preventDefault()
          closeAndReturnFocus()
        }}
      >
        {open && supported ? (
          <NativeChatWorkTargetPickerBody
            botHostId={botHostId}
            platform={platform}
            keybindings={keybindings}
            triggerLabel={triggerLabel}
            selectedTarget={selectedTarget}
            rowsOverride={rowsOverride}
            searchInputRef={searchInputRef}
            onSelectTarget={onSelectTarget}
            closeAndReturnFocus={closeAndReturnFocus}
          />
        ) : null}
      </PopoverContent>
    </Popover>
  )
}

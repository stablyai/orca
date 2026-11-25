import React from 'react'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { LoadingSpinner } from '@/components/ui/LoadingSpinner'
import { LinuxPenguinIcon } from '@/components/icons/LinuxPenguinIcon'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import type { WslHostDistro } from '../../../../../shared/remote-runtime/wsl-hosts/wsl-host-types'
import { useWslDistroList } from '@/components/sidebar/host-admission/wsl/use-wsl-distro-list'
import {
  wsl1DistroReason,
  wslDistroStateLabel
} from '@/components/sidebar/host-admission/wsl/AddWslHostFormPanel'
import { getWslHostServerFilesMissingLabel } from '@/components/sidebar/host-admission/wsl/wsl-host-row-status'
import { useWslHostServerFilesMissing } from '@/runtime/hosts/wsl/use-wsl-hosts-enabled'
import { RunTargetRow } from './RunTargetComboboxRow'
import { wslDistroMenuRows } from './wsl-distro-menu-rows'
import { focusFirstSubmenuOptionWhenMounted, stepSubmenuOptionFocus } from './submenu-option-focus'
import { COMBOBOX_POPOVER_SURFACE } from '../type-ahead/type-ahead-combobox-styles'

const SUBMENU_CONTENT = cn('w-72 p-1', COMBOBOX_POPOVER_SURFACE)
const PENGUIN = <LinuxPenguinIcon className="size-3.5 shrink-0 text-muted-foreground" />

/** Add host's "WSL distro" row and its nested list of this PC's distros that aren't hosts yet. */
export function WslDistroSubmenuRow({
  open,
  focusOnOpen,
  onOpenChange,
  armed,
  onArm,
  onHoverOpen,
  onKeyboardOpen,
  onReturnFocus,
  onPickDistro
}: {
  open: boolean
  /** Opened from the keyboard: the first enabled distro takes focus once the list is read. */
  focusOnOpen: boolean
  onOpenChange: (open: boolean) => void
  /** Highlights the row (pointer or focus). */
  armed: boolean
  onArm: () => void
  /** The pointer rests on the row: open the list, as a menu's submenu does. */
  onHoverOpen: () => void
  /** Enter or ArrowRight on the row: open the list and move focus into it. */
  onKeyboardOpen: () => void
  /** Back from the list to the "WSL distro" row. */
  onReturnFocus: () => void
  onPickDistro: (distro: WslHostDistro) => void
}): React.JSX.Element {
  const t = useTranslate()
  const serverFilesMissing = useWslHostServerFilesMissing()
  // Read only while the list shows: each read spawns wsl.exe.
  const list = useWslDistroList(open && !serverFilesMissing)
  const rows = wslDistroMenuRows(list.distros)
  const [hoveredKey, setHoveredKey] = React.useState<string | null>(null)
  const listRef = React.useRef<HTMLDivElement>(null)
  const loading = list.loading || (list.refreshing && rows.length === 0)
  const note = serverFilesMissing
    ? getWslHostServerFilesMissingLabel(t)
    : loading
      ? null
      : (list.error ??
        (rows.length === 0
          ? t('auto.components.RunTargetCombobox.noWslDistros', 'No WSL distros found')
          : null))
  const enabledCount = rows.filter((row) => !row.disabled).length
  // Distros arrive after the list opens, so focus waits for the first enabled one to render.
  React.useEffect(() => {
    if (!open || !focusOnOpen || loading || enabledCount === 0) {
      return
    }
    // The portaled list can mount a frame after the open state.
    return focusFirstSubmenuOptionWhenMounted(() => listRef.current)
  }, [open, focusOnOpen, loading, enabledCount])
  const back = (): void => {
    onOpenChange(false)
    onReturnFocus()
  }
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor asChild>
        <div
          data-wsl-distro-row=""
          onMouseMove={onHoverOpen}
          onKeyDownCapture={(event) => {
            if (event.key === 'Enter' || event.key === 'ArrowRight') {
              event.preventDefault()
              event.stopPropagation()
              onKeyboardOpen()
            }
          }}
        >
          <RunTargetRow
            icon={PENGUIN}
            label={t('auto.components.RunTargetCombobox.wslDistro', 'WSL distro')}
            detail={t(
              'auto.components.RunTargetCombobox.wslDistroHint',
              'A Linux distro on this PC'
            )}
            armed={armed}
            current={false}
            keyboardFocusable
            optionId={undefined}
            submenu
            onArm={onArm}
            onCommit={() => onOpenChange(true)}
          />
        </div>
      </PopoverAnchor>
      <PopoverContent
        side="right"
        align="start"
        sideOffset={6}
        className={SUBMENU_CONTENT}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => {
          // Escape steps back one level, to the "WSL distro" row, rather than closing the picker.
          event.preventDefault()
          back()
        }}
        data-wsl-distro-menu=""
      >
        <div
          ref={listRef}
          role="listbox"
          aria-label={t('auto.components.RunTargetCombobox.wslDistro', 'WSL distro')}
          aria-busy={loading || undefined}
          className="max-h-72 overflow-y-auto scrollbar-sleek"
          onMouseLeave={() => setHoveredKey(null)}
          onKeyDown={(event) => {
            // Portaled, but React still bubbles keys to Add host's list: handle them here only.
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              event.stopPropagation()
              stepSubmenuOptionFocus(event.currentTarget, event.key === 'ArrowDown' ? 1 : -1)
            } else if (event.key === 'ArrowLeft') {
              event.preventDefault()
              event.stopPropagation()
              back()
            }
          }}
        >
          {loading ? (
            <p className="flex h-8 items-center gap-2 px-2 text-sm text-muted-foreground">
              <LoadingSpinner className="size-3.5" />
              {t('auto.components.sidebar.AddWslHostFormPanel.loading', 'Looking for WSL distros…')}
            </p>
          ) : null}
          {note ? <p className="px-2 py-1.5 text-sm text-muted-foreground">{note}</p> : null}
          {loading
            ? null
            : rows.map(({ distro, disabled }) => (
                <RunTargetRow
                  key={distro.name}
                  icon={PENGUIN}
                  label={distro.name}
                  detail={wslDistroStateLabel(distro, t)}
                  description={distro.version === 1 ? wsl1DistroReason(distro.name, t) : undefined}
                  armed={!disabled && hoveredKey === distro.name}
                  current={false}
                  dimmed={disabled}
                  disabled={disabled}
                  keyboardFocusable={!disabled}
                  optionId={undefined}
                  onArm={() => setHoveredKey(distro.name)}
                  onCommit={() => {
                    if (!disabled) {
                      onPickDistro(distro)
                    }
                  }}
                />
              ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}

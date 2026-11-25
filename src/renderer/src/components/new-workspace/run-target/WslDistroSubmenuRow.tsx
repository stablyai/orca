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
import { COMBOBOX_POPOVER_SURFACE } from '../type-ahead/type-ahead-combobox-styles'

const PENGUIN = <LinuxPenguinIcon className="size-3.5 shrink-0 text-muted-foreground" />

/** Add host's "WSL distro" row and its nested list of this PC's distros that aren't hosts yet. */
export function WslDistroSubmenuRow({
  open,
  onOpenChange,
  armed,
  onArm,
  onPickDistro
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  armed: boolean
  onArm: () => void
  onPickDistro: (distro: WslHostDistro) => void
}): React.JSX.Element {
  const t = useTranslate()
  const serverFilesMissing = useWslHostServerFilesMissing()
  // Read only while the list shows: each read spawns wsl.exe.
  const list = useWslDistroList(open && !serverFilesMissing)
  const rows = wslDistroMenuRows(list.distros)
  const [hoveredKey, setHoveredKey] = React.useState<string | null>(null)
  const loading = list.loading || (list.refreshing && rows.length === 0)
  const note = serverFilesMissing
    ? getWslHostServerFilesMissingLabel(t)
    : loading
      ? null
      : (list.error ??
        (rows.length === 0
          ? t('auto.components.RunTargetCombobox.noWslDistros', 'No WSL distros found')
          : null))
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor asChild>
        <div>
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
        className={cn('w-72 p-1', COMBOBOX_POPOVER_SURFACE)}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        data-wsl-distro-menu=""
      >
        <div
          role="listbox"
          aria-label={t('auto.components.RunTargetCombobox.wslDistro', 'WSL distro')}
          aria-busy={loading || undefined}
          onMouseLeave={() => setHoveredKey(null)}
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

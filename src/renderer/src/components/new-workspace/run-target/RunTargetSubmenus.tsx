import React from 'react'
import { ChevronDown, Cloud, Plus, Server } from 'lucide-react'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import { RunTargetRow } from './RunTargetComboboxRow'
import {
  getEphemeralVmLabel,
  getRecipeDetail,
  type EphemeralVmRecipeOption
} from './run-target-options'
import { COMBOBOX_POPOVER_SURFACE } from '../type-ahead/type-ahead-combobox-styles'
import type { WslHostDistro } from '../../../../../shared/remote-runtime/wsl-hosts/wsl-host-types'
import {
  useWslHostsAcceptNewWork,
  useWslHostsPaused
} from '@/runtime/hosts/wsl/use-wsl-hosts-enabled'
import { getWslHostsPausedShortLabel } from '@/components/sidebar/host-admission/wsl/wsl-host-row-status'
import { WslDistroSubmenuRow } from './WslDistroSubmenuRow'

const SUBMENU_CONTENT = cn('w-72 p-1', COMBOBOX_POPOVER_SURFACE)

/** The "Per-Workspace Environment" row and its nested recipe list. */
export function RecipesSubmenuRow({
  open,
  onOpenChange,
  armed,
  optionId,
  recipes,
  selectedRecipeId,
  onArm,
  onSelectRecipe
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  armed: boolean
  optionId: string | undefined
  recipes: readonly EphemeralVmRecipeOption[]
  selectedRecipeId: string | null
  onArm: () => void
  onSelectRecipe: (recipeId: string) => void
}): React.JSX.Element {
  const t = useTranslate()
  const [hoveredKey, setHoveredKey] = React.useState<string | null>(null)
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor asChild>
        <div>
          <RunTargetRow
            icon={<Cloud className="size-3.5 shrink-0 text-muted-foreground" />}
            label={getEphemeralVmLabel(t)}
            detail={t(
              'auto.components.NewWorkspaceComposerCard.perWorkspaceEnvHint',
              'Provision an on-demand environment from a recipe'
            )}
            armed={armed}
            current={selectedRecipeId !== null}
            optionId={optionId}
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
      >
        {/* Nested rows own hover so pointer movement updates their highlight too. */}
        <div
          role="listbox"
          aria-label={getEphemeralVmLabel(t)}
          onMouseLeave={() => setHoveredKey(null)}
        >
          {recipes.map((recipe) => (
            <RunTargetRow
              key={recipe.id}
              icon={<Cloud className="size-3.5 shrink-0 text-muted-foreground" />}
              label={recipe.name}
              detail={getRecipeDetail(recipe, t)}
              armed={hoveredKey === recipe.id}
              current={recipe.id === selectedRecipeId}
              optionId={undefined}
              onArm={() => setHoveredKey(recipe.id)}
              onCommit={() => onSelectRecipe(recipe.id)}
            />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** Pin Add host so scrolling, filtering and empty results cannot hide it. */
export function AddHostSubmenuRow({
  open,
  focusOnOpen,
  onReturnFocus,
  onOpenChange,
  armed,
  optionId,
  onArm,
  onAddSshHost,
  onAddRemoteServer,
  onAddWslDistro
}: {
  open: boolean
  focusOnOpen: boolean
  onReturnFocus: () => void
  onOpenChange: (open: boolean) => void
  armed: boolean
  optionId: string | undefined
  onArm: () => void
  onAddSshHost?: () => void
  onAddRemoteServer?: () => void
  /** Sets up a distro found on this PC; shown only where WSL hosts take new work (Windows, setting on). */
  onAddWslDistro?: (distro: WslHostDistro) => void
}): React.JSX.Element {
  const t = useTranslate()
  const [hoveredKey, setHoveredKey] = React.useState<string | null>(null)
  const wslAcceptsNewWork = useWslHostsAcceptNewWork()
  const wslPaused = useWslHostsPaused()
  const showWsl = Boolean(onAddWslDistro) && wslAcceptsNewWork
  const wslOpen = open && showWsl && hoveredKey === 'wsl'
  const listRef = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    if (open && focusOnOpen) {
      listRef.current?.querySelector<HTMLElement>('[role="option"]')?.focus()
    }
  }, [open, focusOnOpen])
  const backToPicker = (): void => {
    onOpenChange(false)
    onReturnFocus()
  }
  const addHostLabel = t('auto.components.NewWorkspaceComposerCard.addHost', 'Add host')
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor asChild>
        <div
          role="option"
          id={optionId}
          aria-selected={armed}
          // `option` supports aria-haspopup but not aria-expanded.
          aria-haspopup="menu"
          data-armed={armed || undefined}
          data-run-target-add-host="true"
          onMouseDown={(event) => event.preventDefault()}
          onMouseMove={onArm}
          onClick={() => onOpenChange(true)}
          className={cn(
            'flex h-9 shrink-0 cursor-default items-center gap-2 border-t border-border px-3 text-sm',
            armed && 'bg-accent text-accent-foreground'
          )}
        >
          <span className="flex w-4 shrink-0 items-center justify-center">
            <Plus className="size-3.5 text-muted-foreground" />
          </span>
          <span className="truncate">{addHostLabel}</span>
          <span className="ml-auto flex shrink-0 items-center">
            <ChevronDown className="size-3.5 -rotate-90 text-muted-foreground" />
          </span>
        </div>
      </PopoverAnchor>
      <PopoverContent
        side="right"
        align="end"
        sideOffset={6}
        className={SUBMENU_CONTENT}
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          if (focusOnOpen) {
            listRef.current?.querySelector<HTMLElement>('[role="option"]')?.focus()
          }
        }}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => {
          if (focusOnOpen) {
            event.preventDefault()
            backToPicker()
          }
        }}
      >
        <div
          ref={listRef}
          role="listbox"
          aria-label={addHostLabel}
          onMouseLeave={() => setHoveredKey(null)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft') {
              event.preventDefault()
              backToPicker()
            } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              const items = [
                ...event.currentTarget.querySelectorAll<HTMLElement>('[role="option"]')
              ]
              const next = event.key === 'ArrowDown' ? items.at(-1) : items[0]
              next?.focus()
            }
          }}
        >
          {showWsl && onAddWslDistro ? (
            <WslDistroSubmenuRow
              open={wslOpen}
              onOpenChange={(next) => setHoveredKey(next ? 'wsl' : null)}
              armed={hoveredKey === 'wsl'}
              onArm={() => setHoveredKey('wsl')}
              onPickDistro={onAddWslDistro}
            />
          ) : null}
          {onAddSshHost ? (
            <RunTargetRow
              icon={<Server className="size-3.5 shrink-0 text-muted-foreground" />}
              label={t('auto.components.NewWorkspaceComposerCard.addSshHost', 'Add SSH host')}
              detail={t(
                'auto.components.NewWorkspaceComposerCard.addSshHostHint',
                'Use an existing machine over SSH'
              )}
              armed={hoveredKey === 'ssh'}
              current={false}
              keyboardFocusable
              stacked
              optionId={undefined}
              onArm={() => setHoveredKey('ssh')}
              onCommit={onAddSshHost}
            />
          ) : null}
          {onAddRemoteServer ? (
            <RunTargetRow
              icon={<Cloud className="size-3.5 shrink-0 text-muted-foreground" />}
              label={t(
                'auto.components.NewWorkspaceComposerCard.addRemoteOrcaServer',
                'Add Remote Orca Server'
              )}
              detail={t(
                'auto.components.NewWorkspaceComposerCard.addRemoteOrcaServerHint',
                'Pair another Orca runtime'
              )}
              armed={hoveredKey === 'remote'}
              current={false}
              keyboardFocusable
              stacked
              optionId={undefined}
              onArm={() => setHoveredKey('remote')}
              onCommit={onAddRemoteServer}
            />
          ) : null}
          {onAddWslDistro && !wslAcceptsNewWork && wslPaused ? (
            <p className="px-2 py-1.5 text-2xs text-muted-foreground">
              {getWslHostsPausedShortLabel(t)}
            </p>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  )
}

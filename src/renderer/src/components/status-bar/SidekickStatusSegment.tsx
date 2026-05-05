import React from 'react'
import { Check, Trash2, Upload } from 'lucide-react'
import { toast } from 'sonner'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useAppStore } from '../../store'
import {
  BUNDLED_SIDEKICK,
  BUNDLED_SIDEKICKS,
  findBundledSidekick,
  isBundledSidekickId
} from '../sidekick/sidekick-models'

// Why: cluster sidekick-related controls (show/hide, character picker, custom
// upload + removal, jump-to-settings) behind a single status-bar segment. Only
// rendered when experimentalSidekick is on (gated by the caller). Sidekick
// visibility is independently tracked so users can dismiss without having to
// find the experimental flag again.
function SidekickStatusSegmentInner(): React.JSX.Element {
  const sidekickVisible = useAppStore((s) => s.sidekickVisible)
  const setSidekickVisible = useAppStore((s) => s.setSidekickVisible)
  const sidekickId = useAppStore((s) => s.sidekickId)
  const setSidekickId = useAppStore((s) => s.setSidekickId)
  const customSidekicks = useAppStore((s) => s.customSidekicks)
  const addCustomSidekick = useAppStore((s) => s.addCustomSidekick)
  const removeCustomSidekick = useAppStore((s) => s.removeCustomSidekick)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)

  const bundled = isBundledSidekickId(sidekickId)
  const activeBundled = bundled ? (findBundledSidekick(sidekickId) ?? BUNDLED_SIDEKICK) : null
  const activeCustom = bundled ? null : customSidekicks.find((m) => m.id === sidekickId)
  const activeLabel = activeBundled ? activeBundled.label : (activeCustom?.label ?? 'Sidekick')
  const label = sidekickVisible ? activeLabel : `${activeLabel} hidden`

  const handleImport = async (): Promise<void> => {
    console.log('[sidekick-overlay] upload: click')
    if (!window.api?.sidekick?.import) {
      console.warn('[sidekick-overlay] upload: window.api.sidekick.import missing — restart Orca')
      toast.error('Custom sidekick upload needs a full app restart (not just reload).')
      return
    }
    try {
      const model = await window.api.sidekick.import()
      console.log('[sidekick-overlay] upload: result', model)
      if (!model) {
        return
      }
      addCustomSidekick(model)
      if (!sidekickVisible) {
        setSidekickVisible(true)
      }
      setSidekickId(model.id)
    } catch (error) {
      console.error('[sidekick-overlay] upload: error', error)
      toast.error(error instanceof Error ? error.message : 'Failed to import file')
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="group inline-flex items-center cursor-pointer pl-1 pr-[6.5rem] py-0.5"
          aria-label="Sidekick menu"
        >
          <span
            className={`rounded px-1 py-0.5 text-[11px] font-medium text-muted-foreground group-hover:bg-accent/70 group-hover:text-foreground ${sidekickVisible ? '' : 'opacity-50'}`}
          >
            {label}
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="end" sideOffset={8} className="min-w-[220px]">
        <DropdownMenuLabel>Sidekick</DropdownMenuLabel>
        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault()
            setSidekickVisible(!sidekickVisible)
          }}
        >
          {sidekickVisible ? 'Hide sidekick' : 'Show sidekick'}
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Choose sidekick</DropdownMenuSubTrigger>
          {/* Why: portal so the submenu escapes the parent Content's overflow
              clipping — without this, the submenu opens inside the scroll
              container and gets clipped. Matches the convention used in
              BrowserToolbarMenu/BrowserProfileRow. */}
          <DropdownMenuPortal>
            <DropdownMenuSubContent className="min-w-[220px]">
              {BUNDLED_SIDEKICKS.map((sidekick) => {
                const selected = sidekick.id === sidekickId
                return (
                  <DropdownMenuItem
                    key={sidekick.id}
                    onSelect={() => {
                      if (!sidekickVisible) {
                        setSidekickVisible(true)
                      }
                      setSidekickId(sidekick.id)
                    }}
                  >
                    <span className="flex w-4 items-center justify-center">
                      {selected ? <Check className="size-3.5" aria-hidden /> : null}
                    </span>
                    {sidekick.label}
                  </DropdownMenuItem>
                )
              })}
              {customSidekicks.length > 0 ? <DropdownMenuSeparator /> : null}
              {customSidekicks.map((model) => {
                const selected = model.id === sidekickId
                return (
                  <DropdownMenuItem
                    key={model.id}
                    className="group"
                    onSelect={() => {
                      if (!sidekickVisible) {
                        setSidekickVisible(true)
                      }
                      setSidekickId(model.id)
                    }}
                  >
                    <span className="flex w-4 items-center justify-center">
                      {selected ? <Check className="size-3.5" aria-hidden /> : null}
                    </span>
                    <span className="flex-1 truncate">{model.label}</span>
                    <button
                      type="button"
                      className="ml-2 flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-destructive/15 hover:text-destructive"
                      aria-label={`Remove ${model.label}`}
                      onClick={(event) => {
                        event.stopPropagation()
                        event.preventDefault()
                        removeCustomSidekick(model.id)
                      }}
                    >
                      <Trash2 className="size-3" aria-hidden />
                    </button>
                  </DropdownMenuItem>
                )
              })}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => {
                  // Why: let the menu close naturally (no preventDefault) before
                  // invoking the native file picker. Keeping the menu open when
                  // the OS dialog opens caused the dialog to appear behind the
                  // dropdown overlay on macOS.
                  void handleImport()
                }}
              >
                <Upload className="size-3.5" aria-hidden />
                Upload your own…
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuPortal>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            openSettingsTarget({
              pane: 'experimental',
              repoId: null,
              sectionId: 'experimental-sidekick'
            })
            openSettingsPage()
          }}
        >
          Sidekick settings…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export const SidekickStatusSegment = React.memo(SidekickStatusSegmentInner)

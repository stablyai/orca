// Run on as one click: "This computer · Orca Cloud · ⋯" (spec D1). ⋯ opens today's host picker
// without its Orca Cloud row, and a target picked there replaces ⋯ so the choice stays visible.
import React, { useEffect, useMemo, useState } from 'react'
import { Cloud, Ellipsis, Monitor } from 'lucide-react'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { SettingsSegmentedControl } from '@/components/settings/form-controls/SettingsSegmentedControl'
import { useTranslate } from '@/i18n/use-translate'
import { isMacUserAgent } from '@/lib/user-agent-platform'
import type { ReadyProjectHostSetupOption } from '@/lib/project-host-setup-options'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host'
import { ORCA_CLOUD_RECIPE_ID } from '../../../../../shared/hosted-sandbox/orca-cloud-recipe-id'
import type { OrcaCloudAvailability } from '../../../../../shared/orca-yaml-hook-types'
import RunTargetCombobox from '../RunTargetCombobox'
import { isOrcaCloudRecipe } from '../run-target-options'
import { getOrcaCloudSegmentState, getRunOnSegment, type RunOnSegment } from './cloud-start-model'

type RunTargetComboboxProps = React.ComponentProps<typeof RunTargetCombobox>

export type RunOnSegmentedControlProps = RunTargetComboboxProps & {
  orcaCloudAvailability: OrcaCloudAvailability
  /** Selects Orca Cloud even when the account still needs setup; the panel below says what's missing. */
  onSelectOrcaCloud: () => void
  /** Marks the control as touched so a remembered default never overrides a user pick. */
  onUserPick?: () => void
}

/** ⌥⌘1 / ⌥⌘2 (Ctrl+Alt on Windows/Linux) while the composer is open (spec D1, N8). */
export function matchRunOnShortcut(
  event: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'code'>,
  mac: boolean
): 'local' | 'orca-cloud' | null {
  const mod = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
  if (!mod || !event.altKey || event.shiftKey) {
    return null
  }
  if (event.code === 'Digit1') {
    return 'local'
  }
  return event.code === 'Digit2' ? 'orca-cloud' : null
}

export default function RunOnSegmentedControl(
  props: RunOnSegmentedControlProps
): React.JSX.Element {
  const {
    hostOptions,
    hostValue,
    hostExecutionHostId,
    onHostChange,
    recipes,
    recipeValue,
    onRecipeChange,
    orcaCloudAvailability,
    onSelectOrcaCloud,
    onUserPick
  } = props
  const t = useTranslate()
  const [moreOpen, setMoreOpen] = useState(false)
  const mac = isMacUserAgent()

  const localOption = useMemo(
    () =>
      hostOptions.find(
        (option): option is ReadyProjectHostSetupOption =>
          option.kind === 'ready' && option.hostId === LOCAL_EXECUTION_HOST_ID
      ) ?? null,
    [hostOptions]
  )
  const selectedRecipe = recipes.find((recipe) => recipe.id === recipeValue) ?? null
  const orcaCloudSelected = recipeValue === ORCA_CLOUD_RECIPE_ID
  const selectedHost =
    hostOptions.find(
      (option) =>
        option.kind === 'ready' &&
        option.id === hostValue &&
        (!hostExecutionHostId || option.hostId === hostExecutionHostId)
    ) ?? null
  const segment = getRunOnSegment({
    orcaCloudSelected,
    otherRecipeSelected: selectedRecipe !== null && !orcaCloudSelected,
    selectedHostIsLocal: selectedHost ? selectedHost.hostId === LOCAL_EXECUTION_HOST_ID : null
  })
  const cloudState = getOrcaCloudSegmentState(orcaCloudAvailability)

  const pickLocal = (): void => {
    if (!localOption) {
      return
    }
    onUserPick?.()
    onRecipeChange?.(null)
    onHostChange?.(localOption.id)
  }
  const pickCloud = (): void => {
    if (cloudState !== 'enabled') {
      return
    }
    onUserPick?.()
    onSelectOrcaCloud()
  }

  // ⌥⌘1 / ⌥⌘2 only while this composer is mounted; Run on stays the one place they act.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = matchRunOnShortcut(event, mac)
      if (!target) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      if (target === 'local') {
        pickLocal()
      } else {
        pickCloud()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  })

  const shortcut = (digit: 1 | 2): string => (mac ? `⌥⌘${digit}` : `Ctrl+Alt+${digit}`)
  const otherLabel =
    segment === 'other'
      ? ((selectedRecipe && !isOrcaCloudRecipe(selectedRecipe)
          ? selectedRecipe.name
          : selectedHost?.label) ?? null)
      : null

  const options = [
    {
      value: 'local' as const,
      label: (
        <span className="flex items-center gap-1.5">
          <Monitor className="size-3.5" aria-hidden />
          {t('components.newWorkspace.runOn.thisComputer', 'This computer')}
        </span>
      ),
      disabled: !localOption,
      tooltip: localOption
        ? t('components.newWorkspace.runOn.thisComputerTooltip', '{{machine}} · {{shortcut}}', {
            machine: localOption.label,
            shortcut: shortcut(1)
          })
        : t(
            'components.newWorkspace.runOn.noLocalCheckout',
            'This project has no location on this computer.'
          )
    },
    ...(cloudState === 'hidden'
      ? []
      : [
          {
            value: 'orca-cloud' as const,
            label: (
              <span className="flex items-center gap-1.5">
                <Cloud className="size-3.5" aria-hidden />
                {t('components.newWorkspace.runOn.orcaCloud', 'Orca Cloud')}
              </span>
            ),
            disabled: cloudState === 'unreachable',
            tooltip:
              cloudState === 'unreachable'
                ? t(
                    'components.newWorkspace.runOn.cloudUnreachable',
                    "Can't reach Orca Cloud right now. Check your connection."
                  )
                : t('components.newWorkspace.runOn.cloudTooltip', 'Hosted sandbox · {{shortcut}}', {
                    shortcut: shortcut(2)
                  })
          }
        ]),
    {
      value: 'other' as const,
      ariaLabel: otherLabel
        ? t('components.newWorkspace.runOn.moreWithTarget', 'More places to run: {{name}}', {
            name: otherLabel
          })
        : t('components.newWorkspace.runOn.more', 'More places to run'),
      label: otherLabel ? (
        <span className="block max-w-28 truncate">{otherLabel}</span>
      ) : (
        <Ellipsis className="size-3.5" aria-hidden />
      ),
      tooltip: t('components.newWorkspace.runOn.more', 'More places to run')
    }
  ]

  // The host picker keeps everything except Orca Cloud, which now has its own segment.
  const otherRecipes = useMemo(
    () => recipes.filter((recipe) => !isOrcaCloudRecipe(recipe)),
    [recipes]
  )

  return (
    <Popover open={moreOpen} onOpenChange={setMoreOpen}>
      <PopoverAnchor asChild>
        <div
          className="w-fit max-w-full"
          data-run-on-segmented="true"
          aria-keyshortcuts={mac ? 'Alt+Meta+1 Alt+Meta+2' : 'Control+Alt+1 Control+Alt+2'}
        >
          <SettingsSegmentedControl<RunOnSegment>
            value={segment ?? 'local'}
            activation="manual"
            size="sm"
            ariaLabel={t('auto.components.NewWorkspaceComposerCard.runOn', 'Run on')}
            options={options}
            onChange={(value) => {
              if (value === 'local') {
                pickLocal()
              } else if (value === 'orca-cloud') {
                pickCloud()
              } else {
                setMoreOpen(true)
              }
            }}
          />
        </div>
      </PopoverAnchor>
      <PopoverContent align="end" className="w-80" data-run-on-more="true">
        <RunTargetCombobox
          {...props}
          recipes={otherRecipes}
          recipeValue={selectedRecipe && !orcaCloudSelected ? recipeValue : null}
          orcaCloudAvailability="unavailable"
          onHostChange={(setupId) => {
            onUserPick?.()
            onRecipeChange?.(null)
            onHostChange?.(setupId)
            setMoreOpen(false)
          }}
          onRecipeChange={(recipeId) => {
            onUserPick?.()
            onRecipeChange?.(recipeId)
            setMoreOpen(false)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}

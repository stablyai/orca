import type React from 'react'
import { useMemo } from 'react'
import { Check, Monitor, Moon, Sun } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import { usePluginTerminalThemes, usePluginThemes } from '@/store/plugin-themes'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { SettingsSegmentedControl } from '../settings/form-controls/SettingsFormControls'
import { buildThemeLooks, type ThemeLook, type ThemeLookBase } from './onboarding-theme-looks'
import { selectedThemeLookId } from './onboarding-theme-look-settings'
import { ThemeLookSwatch } from './ThemeLookPreview'

export type ThemeLooksByBase = Record<ThemeLookBase, ThemeLook[]>

/** The looks for both modes and which one each mode's slot holds now. */
export function useThemeLooks(
  settings: GlobalSettings | null,
  baseline: GlobalSettings | null
): {
  looks: ThemeLooksByBase
  selected: Record<ThemeLookBase, string | null>
  pluginTerminalThemes: ReturnType<typeof usePluginTerminalThemes>
} {
  const pluginThemes = usePluginThemes()
  const pluginTerminalThemes = usePluginTerminalThemes()
  const languageRevision = useUiLanguageRevision()
  const looks = useMemo<ThemeLooksByBase>(() => {
    if (!baseline) {
      return { dark: [], light: [] }
    }
    const labels = {
      orca: translate('components.onboarding.theme.looks.sourceBuiltIn', 'Built in'),
      community: translate('components.onboarding.theme.looks.sourceCommunity', 'Terminal palette'),
      builtIn: (base: ThemeLookBase) =>
        base === 'dark'
          ? translate('components.onboarding.theme.looks.orcaDark', 'Orca Dark')
          : translate('components.onboarding.theme.looks.orcaLight', 'Orca Light')
    }
    const build = (base: ThemeLookBase): ThemeLook[] =>
      buildThemeLooks({ base, pluginThemes, pluginTerminalThemes, baseline, labels })
    return { dark: build('dark'), light: build('light') }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- languageRevision re-reads translated labels
  }, [baseline, pluginThemes, pluginTerminalThemes, languageRevision])
  const selected = {
    dark: settings ? selectedThemeLookId(settings, 'dark', looks.dark) : null,
    light: settings ? selectedThemeLookId(settings, 'light', looks.light) : null
  }
  return { looks, selected, pluginTerminalThemes }
}

export function ThemeModeControl({
  value,
  onChange
}: {
  value: GlobalSettings['theme']
  onChange: (theme: GlobalSettings['theme']) => void
}): React.JSX.Element {
  const option = (icon: React.ReactNode, label: string): React.ReactNode => (
    <span className="flex items-center gap-1.5">
      {icon}
      {label}
    </span>
  )
  return (
    <SettingsSegmentedControl
      ariaLabel={translate('components.onboarding.theme.modeLabel', 'Appearance mode')}
      value={value}
      onChange={onChange}
      options={[
        {
          value: 'system',
          label: option(
            <Monitor className="size-3.5" />,
            translate('auto.components.onboarding.ThemeStep.827ea7b4a2', 'System')
          )
        },
        {
          value: 'light',
          label: option(
            <Sun className="size-3.5" />,
            translate('auto.components.onboarding.ThemeStep.ad192706e6', 'Light')
          )
        },
        {
          value: 'dark',
          label: option(
            <Moon className="size-3.5" />,
            translate('auto.components.onboarding.ThemeStep.fa7b673ea9', 'Dark')
          )
        }
      ]}
    />
  )
}

/** Under System: which of the two persisted looks the list edits; marks the one showing now. */
export function ThemeSlotControl({
  value,
  osBase,
  onChange
}: {
  value: ThemeLookBase
  osBase: ThemeLookBase
  onChange: (base: ThemeLookBase) => void
}): React.JSX.Element {
  const label = (base: ThemeLookBase): React.ReactNode => (
    <span className="flex items-center gap-1.5">
      {base === 'dark'
        ? translate('components.onboarding.theme.looks.darkLook', 'Dark look')
        : translate('components.onboarding.theme.looks.lightLook', 'Light look')}
      {base === osBase && (
        <span className="text-2xs font-normal text-muted-foreground">
          {translate('components.onboarding.theme.looks.activeNow', 'now')}
        </span>
      )}
    </span>
  )
  return (
    <SettingsSegmentedControl
      ariaLabel={translate('components.onboarding.theme.looks.slotLabel', 'Look to edit')}
      value={value}
      onChange={onChange}
      equalWidth
      size="sm"
      options={[
        { value: 'dark', label: label('dark') },
        { value: 'light', label: label('light') }
      ]}
    />
  )
}

type ThemeLookGroup = { id: string; title: string; caption?: string; looks: ThemeLook[] }

/** The step's look picker: arrow keys move and preview, Enter or click applies. */
export function ThemeLookList({
  groups,
  selectedId,
  onPick,
  onPreview,
  ariaLabel
}: {
  groups: ThemeLookGroup[]
  selectedId: string | null
  onPick: (look: ThemeLook) => void
  onPreview: (look: ThemeLook | null) => void
  ariaLabel: string
}): React.JSX.Element {
  const looks = groups.flatMap((group) => group.looks)
  const tabStopId = looks.some((look) => look.id === selectedId) ? selectedId : looks[0]?.id

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const keys: Record<string, (index: number) => number> = {
      ArrowDown: (index) => Math.min(index + 1, looks.length - 1),
      ArrowUp: (index) => Math.max(index - 1, 0),
      Home: () => 0,
      End: () => looks.length - 1
    }
    const move = keys[event.key]
    const targetId = event.target instanceof HTMLElement ? event.target.dataset.themeLook : null
    const current = looks.findIndex((look) => look.id === targetId)
    if (!move || current === -1) {
      return
    }
    event.preventDefault()
    const next = looks[move(current)]
    event.currentTarget
      .querySelector<HTMLElement>(`[data-theme-look="${CSS.escape(next.id)}"]`)
      ?.focus()
  }

  return (
    <div role="group" aria-label={ariaLabel} className="space-y-4" onKeyDown={onKeyDown}>
      {groups.map((group) => (
        <div key={group.id} role="group" aria-labelledby={`theme-look-group-${group.id}`}>
          <div className="px-2 pb-1.5">
            <div
              id={`theme-look-group-${group.id}`}
              className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
            >
              {group.title}
            </div>
            {group.caption && (
              <div className="mt-0.5 text-xs text-muted-foreground/80">{group.caption}</div>
            )}
          </div>
          <div className="space-y-px">
            {group.looks.map((look) => {
              const selected = look.id === selectedId
              return (
                <button
                  key={look.id}
                  type="button"
                  // Why not radio: arrows preview without applying, so aria-pressed marks the applied look.
                  aria-pressed={selected}
                  tabIndex={look.id === tabStopId ? 0 : -1}
                  data-theme-look={look.id}
                  className={cn(
                    'flex h-9 w-full items-center gap-2.5 rounded-md px-2 text-left text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none',
                    selected
                      ? 'bg-accent font-medium text-foreground ring-1 ring-border'
                      : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                  )}
                  onClick={() => onPick(look)}
                  onPointerEnter={() => onPreview(look)}
                  onPointerLeave={() => onPreview(null)}
                  onFocus={() => onPreview(look)}
                  onBlur={() => onPreview(null)}
                >
                  <ThemeLookSwatch palette={look.palette} />
                  <span className="min-w-0 flex-1 truncate">{look.label}</span>
                  {selected && <Check className="size-3.5 shrink-0" />}
                </button>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}

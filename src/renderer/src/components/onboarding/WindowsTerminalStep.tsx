import { Check } from 'lucide-react'
import { useCallback, useState } from 'react'
import type { BuiltInWindowsTerminalShell } from '../../../../shared/windows-terminal-shell'
import { WINDOWS_GIT_BASH_SHELL } from '../../../../shared/windows-terminal-shell'
import type { GlobalSettings } from '../../../../shared/types'
import { cn } from '@/lib/utils'
import { useWindowsTerminalCapabilities } from '@/lib/windows-terminal-capabilities'
import { SettingsSegmentedControl } from '../settings/SettingsFormControls'
import { ShellIcon } from '../tab-bar/shell-icons'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { translate } from '@/i18n/i18n'

type WindowsTerminalStepProps = {
  settings: GlobalSettings | null
  updateSettings: (updates: Partial<GlobalSettings>) => Promise<void> | void
}

type ShellOption = {
  value: BuiltInWindowsTerminalShell
  label: string
  description: string
  disabled?: boolean
}

type RightClickOption = {
  value: 'paste' | 'menu'
  label: string
  description: string
}

const DEFAULT_WSL_DISTRO_VALUE = '__default__'

function normalizeWindowsShell(value: string | null | undefined): BuiltInWindowsTerminalShell {
  if (
    value === 'powershell.exe' ||
    value === 'cmd.exe' ||
    value === 'wsl.exe' ||
    value === WINDOWS_GIT_BASH_SHELL
  ) {
    return value
  }
  return 'powershell.exe'
}

export function WindowsTerminalStep({
  settings,
  updateSettings
}: WindowsTerminalStepProps): React.JSX.Element {
  const capabilities = useWindowsTerminalCapabilities(Boolean(settings), true)
  const [selectPortalRoot, setSelectPortalRoot] = useState<HTMLElement | null>(null)
  const windowsShell = normalizeWindowsShell(settings?.terminalWindowsShell)
  const selectedWslDistroName = settings?.terminalWindowsWslDistro?.trim() || null
  const selectedWslDistro = selectedWslDistroName || DEFAULT_WSL_DISTRO_VALUE
  const wslDistroOptions =
    selectedWslDistroName && !capabilities.wslDistros.includes(selectedWslDistroName)
      ? [selectedWslDistroName, ...capabilities.wslDistros]
      : capabilities.wslDistros
  const showGitBashOption = capabilities.gitBashAvailable || windowsShell === WINDOWS_GIT_BASH_SHELL
  const showWslOption = capabilities.wslAvailable || windowsShell === 'wsl.exe'

  const setSelectPortalHost = useCallback((node: HTMLDivElement | null) => {
    // Why: onboarding sits above body-level portals, so the distro menu must
    // portal into the overlay to stay clickable.
    setSelectPortalRoot(node?.closest<HTMLElement>('[data-onboarding-overlay]') ?? node)
  }, [])

  const shellOptions: ShellOption[] = [
    {
      value: 'powershell.exe',
      label: translate('auto.components.onboarding.WindowsTerminalStep.powerShell', 'PowerShell'),
      description: capabilities.pwshAvailable
        ? translate(
            'auto.components.onboarding.WindowsTerminalStep.powerShellPwsh',
            'Uses PowerShell 7+ when available, with Windows PowerShell as fallback.'
          )
        : translate(
            'auto.components.onboarding.WindowsTerminalStep.powerShellInbox',
            'Uses the Windows PowerShell available on every supported Windows install.'
          )
    },
    {
      value: 'cmd.exe',
      label: translate(
        'auto.components.onboarding.WindowsTerminalStep.commandPrompt',
        'Command Prompt'
      ),
      description: translate(
        'auto.components.onboarding.WindowsTerminalStep.commandPromptDescription',
        'Opens new terminal panes with classic cmd.exe behavior.'
      )
    },
    ...(showGitBashOption
      ? [
          {
            value: WINDOWS_GIT_BASH_SHELL,
            label: translate('auto.components.onboarding.WindowsTerminalStep.gitBash', 'Git Bash'),
            description: capabilities.gitBashAvailable
              ? translate(
                  'auto.components.onboarding.WindowsTerminalStep.gitBashDescription',
                  'Uses Git for Windows bash.exe for Unix-style shell workflows.'
                )
              : translate(
                  'auto.components.onboarding.WindowsTerminalStep.gitBashUnavailable',
                  'Selected, but Git Bash was not detected on this machine.'
                ),
            disabled: !capabilities.gitBashAvailable
          } satisfies ShellOption
        ]
      : []),
    ...(showWslOption
      ? [
          {
            value: 'wsl.exe',
            label: translate('auto.components.onboarding.WindowsTerminalStep.wsl', 'WSL'),
            description: capabilities.wslAvailable
              ? translate(
                  'auto.components.onboarding.WindowsTerminalStep.wslDescription',
                  'Starts new terminal panes inside your Windows Subsystem for Linux default.'
                )
              : translate(
                  'auto.components.onboarding.WindowsTerminalStep.wslUnavailable',
                  'Selected, but WSL was not detected on this machine.'
                ),
            disabled: !capabilities.wslAvailable
          } satisfies ShellOption
        ]
      : [])
  ]

  const rightClickOptions: RightClickOption[] = [
    {
      value: 'paste',
      label: translate(
        'auto.components.onboarding.WindowsTerminalStep.rightClickPaste',
        'Paste on right-click'
      ),
      description: translate(
        'auto.components.onboarding.WindowsTerminalStep.rightClickPasteDescription',
        'Right-click pastes the clipboard. Ctrl+right-click opens the context menu.'
      )
    },
    {
      value: 'menu',
      label: translate(
        'auto.components.onboarding.WindowsTerminalStep.rightClickMenu',
        'Open context menu'
      ),
      description: translate(
        'auto.components.onboarding.WindowsTerminalStep.rightClickMenuDescription',
        'Right-click opens the terminal menu. Paste from the menu or keyboard.'
      )
    }
  ]

  if (!settings) {
    return (
      <div className="rounded-xl border border-border bg-muted/20 px-5 py-4 text-sm text-muted-foreground">
        {translate(
          'auto.components.onboarding.WindowsTerminalStep.loading',
          'Loading terminal settings...'
        )}
      </div>
    )
  }

  const rightClickValue = settings.terminalRightClickToPaste ? 'paste' : 'menu'
  const rightClickDescription =
    rightClickOptions.find((option) => option.value === rightClickValue)?.description ??
    rightClickOptions[0].description

  return (
    <div ref={setSelectPortalHost} className="space-y-6" data-windows-terminal-step>
      <section className="space-y-3">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold text-foreground">
            {translate(
              'auto.components.onboarding.WindowsTerminalStep.defaultShell',
              'Default Shell'
            )}
          </h2>
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            {translate(
              'auto.components.onboarding.WindowsTerminalStep.defaultShellDescription',
              'Choose the shell Orca opens for new Windows terminal panes.'
            )}
          </p>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          {shellOptions.map((option) => (
            <PreferenceCard
              key={option.value}
              icon={<ShellIcon shell={option.value} size={18} />}
              label={option.label}
              description={option.description}
              selected={windowsShell === option.value}
              disabled={option.disabled}
              onClick={() => void updateSettings({ terminalWindowsShell: option.value })}
            />
          ))}
        </div>

        {windowsShell === 'wsl.exe' ? (
          <div className="rounded-xl border border-border bg-muted/20 px-4 py-3">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 space-y-1">
                <div className="text-sm font-medium text-foreground">
                  {translate(
                    'auto.components.onboarding.WindowsTerminalStep.wslDistribution',
                    'WSL Distribution'
                  )}
                </div>
                <p className="text-[13px] leading-relaxed text-muted-foreground">
                  {translate(
                    'auto.components.onboarding.WindowsTerminalStep.wslDistributionDescription',
                    'Use the Windows default distribution or choose a specific installed distro.'
                  )}
                </p>
              </div>
              <Select
                value={selectedWslDistro}
                disabled={capabilities.isLoading || !capabilities.wslAvailable}
                onValueChange={(value) =>
                  void updateSettings({
                    terminalWindowsWslDistro: value === DEFAULT_WSL_DISTRO_VALUE ? null : value
                  })
                }
              >
                <SelectTrigger
                  size="sm"
                  aria-label={translate(
                    'auto.components.onboarding.WindowsTerminalStep.wslDistribution',
                    'WSL Distribution'
                  )}
                  className="w-full sm:w-52"
                >
                  <SelectValue
                    placeholder={
                      capabilities.isLoading
                        ? translate(
                            'auto.components.onboarding.WindowsTerminalStep.loadingDistros',
                            'Loading distributions'
                          )
                        : translate(
                            'auto.components.onboarding.WindowsTerminalStep.windowsDefault',
                            'Windows default'
                          )
                    }
                  />
                </SelectTrigger>
                <SelectContent
                  portalContainer={selectPortalRoot}
                  align="end"
                  className="z-[120] w-[--radix-select-trigger-width]"
                >
                  <SelectItem value={DEFAULT_WSL_DISTRO_VALUE}>
                    {translate(
                      'auto.components.onboarding.WindowsTerminalStep.windowsDefault',
                      'Windows default'
                    )}
                  </SelectItem>
                  {wslDistroOptions.map((distro) => (
                    <SelectItem key={distro} value={distro}>
                      {distro}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        ) : null}
      </section>

      <section className="space-y-3">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold text-foreground">
            {translate(
              'auto.components.onboarding.WindowsTerminalStep.rightClickBehavior',
              'Right-click behavior'
            )}
          </h2>
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            {translate(
              'auto.components.onboarding.WindowsTerminalStep.rightClickBehaviorDescription',
              'Pick the terminal mouse behavior that matches your Windows muscle memory.'
            )}
          </p>
        </div>

        <div className="max-w-xl space-y-2">
          <SettingsSegmentedControl
            value={rightClickValue}
            onChange={(value) =>
              void updateSettings({ terminalRightClickToPaste: value === 'paste' })
            }
            options={rightClickOptions}
            ariaLabel={translate(
              'auto.components.onboarding.WindowsTerminalStep.rightClickBehavior',
              'Right-click behavior'
            )}
            equalWidth
          />
          <p className="text-[12px] leading-relaxed text-muted-foreground">
            {rightClickDescription}
          </p>
        </div>
      </section>
    </div>
  )
}

function PreferenceCard({
  icon,
  label,
  description,
  selected,
  disabled,
  onClick
}: {
  icon: React.JSX.Element
  label: string
  description: string
  selected: boolean
  disabled?: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'group relative min-h-28 rounded-xl border p-4 text-left outline-none transition-all focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60',
        selected
          ? 'border-foreground/55 bg-foreground/[0.06] ring-2 ring-ring/35'
          : 'border-border bg-muted/25 hover:bg-muted/45'
      )}
    >
      {selected ? (
        <span className="absolute right-3 top-3 grid size-5 place-items-center rounded-full bg-primary text-primary-foreground shadow-sm">
          <Check className="size-3" strokeWidth={3} />
        </span>
      ) : null}
      <span className="flex min-w-0 items-start gap-3 pr-7">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-border bg-background text-foreground">
          {icon}
        </span>
        <span className="min-w-0 space-y-1">
          <span className="block text-sm font-medium text-foreground">{label}</span>
          <span className="block text-[12px] leading-relaxed text-muted-foreground">
            {description}
          </span>
        </span>
      </span>
    </button>
  )
}

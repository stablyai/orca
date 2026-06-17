import type { GlobalSettings } from '../../../../shared/types'
import { Input } from '../ui/input'
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group'
import { clampNumber } from '@/lib/terminal-theme'
import {
  SettingsRow,
  SettingsSegmentedControl,
  SettingsSubsectionHeader
} from './SettingsFormControls'
import { SCROLLBACK_PRESETS_MB } from './SettingsConstants'
import { SearchableSetting } from './SearchableSetting'
import { matchesSettingsSearch } from './settings-search'
import { getTerminalWindowsPowershellImplementationSearchEntry } from './terminal-windows-search'
import { TerminalMacKeyboardSection } from './TerminalMacKeyboardSection'
import { translate } from '@/i18n/i18n'

type TerminalAdvancedSectionProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  scrollbackMode: 'preset' | 'custom'
  setScrollbackMode: (mode: 'preset' | 'custom') => void
  searchQuery: string
  showWindowsPowerShellImplementation: boolean
  pwshAvailable?: boolean
  isMac: boolean
}

export function TerminalAdvancedSection({
  settings,
  updateSettings,
  scrollbackMode,
  setScrollbackMode,
  searchQuery,
  showWindowsPowerShellImplementation,
  pwshAvailable,
  isMac
}: TerminalAdvancedSectionProps): React.JSX.Element {
  const scrollbackMb = Math.max(1, Math.round(settings.terminalScrollbackBytes / 1_000_000))
  const isPreset = SCROLLBACK_PRESETS_MB.includes(
    scrollbackMb as (typeof SCROLLBACK_PRESETS_MB)[number]
  )
  const scrollbackToggleValue =
    scrollbackMode === 'custom' ? 'custom' : isPreset ? `${scrollbackMb}` : 'custom'
  const powerShellImplementation = settings.terminalWindowsPowerShellImplementation ?? 'auto'

  return (
    <section key="advanced" className="space-y-3">
      <SettingsSubsectionHeader
        title={translate('auto.components.settings.TerminalPane.5e5f06c82c', 'Advanced')}
        description={translate(
          'auto.components.settings.TerminalPane.267d020745',
          'Scrollback, word boundaries, and platform-specific terminal behaviors.'
        )}
      />

      <div className="divide-y divide-border/40">
        <SearchableSetting
          title={translate('auto.components.settings.TerminalPane.9df53f7c14', 'Scrollback Size')}
          description={translate(
            'auto.components.settings.TerminalPane.c3810b2b42',
            'Maximum terminal scrollback buffer size.'
          )}
          keywords={['terminal', 'scrollback', 'buffer', 'memory']}
        >
          <SettingsRow
            alignTop={scrollbackMode === 'custom'}
            label={translate('auto.components.settings.TerminalPane.9df53f7c14', 'Scrollback Size')}
            description={translate(
              'auto.components.settings.TerminalPane.81d86b2dd2',
              'Maximum terminal scrollback buffer size for new terminal panes.'
            )}
            control={
              <div className="flex flex-col items-end gap-2">
                <ToggleGroup
                  type="single"
                  value={scrollbackToggleValue}
                  onValueChange={(value) => {
                    if (!value) {
                      return
                    }
                    if (value === 'custom') {
                      setScrollbackMode('custom')
                      return
                    }

                    setScrollbackMode('preset')
                    updateSettings({
                      terminalScrollbackBytes: Number(value) * 1_000_000
                    })
                  }}
                  variant="outline"
                  size="sm"
                  className="h-8 flex-wrap justify-end"
                >
                  {SCROLLBACK_PRESETS_MB.map((preset) => (
                    <ToggleGroupItem
                      key={preset}
                      value={`${preset}`}
                      className="h-8 px-3 text-xs"
                      aria-label={translate(
                        'auto.components.settings.TerminalPane.5336c096af',
                        '{{value0}} megabytes',
                        { value0: preset }
                      )}
                    >
                      {preset} {translate('auto.components.settings.TerminalPane.12e06178fa', 'MB')}
                    </ToggleGroupItem>
                  ))}
                  <ToggleGroupItem
                    value="custom"
                    className="h-8 px-3 text-xs"
                    aria-label={translate(
                      'auto.components.settings.TerminalPane.907b0b9d3e',
                      'Custom'
                    )}
                  >
                    {translate('auto.components.settings.TerminalPane.907b0b9d3e', 'Custom')}
                  </ToggleGroupItem>
                </ToggleGroup>
                {scrollbackMode === 'custom' ? (
                  <div className="flex items-center gap-2">
                    <Input
                      type="number"
                      min={1}
                      max={256}
                      step={1}
                      value={scrollbackMb}
                      onChange={(e) => {
                        const value = Number(e.target.value)
                        if (Number.isFinite(value)) {
                          updateSettings({
                            terminalScrollbackBytes: clampNumber(value, 1, 256) * 1_000_000
                          })
                        }
                      }}
                      className="number-input-clean w-24 tabular-nums"
                    />
                    <span className="text-xs text-muted-foreground">
                      {translate('auto.components.settings.TerminalPane.12e06178fa', 'MB')}
                    </span>
                  </div>
                ) : null}
              </div>
            }
          />
        </SearchableSetting>

        <SearchableSetting
          title={translate('auto.components.settings.TerminalPane.4bebcc2b2c', 'Word Separators')}
          description={translate(
            'auto.components.settings.TerminalPane.8a956cc91e',
            'Characters treated as word boundaries for double-click selection.'
          )}
          keywords={['word', 'separator', 'boundary', 'double-click', 'selection']}
        >
          <SettingsRow
            label={translate('auto.components.settings.TerminalPane.4bebcc2b2c', 'Word Separators')}
            description={translate(
              'auto.components.settings.TerminalPane.8a956cc91e',
              'Characters treated as word boundaries for double-click selection.'
            )}
            control={
              <Input
                value={settings.terminalWordSeparator ?? ''}
                onChange={(e) => {
                  const value = e.target.value
                  updateSettings({ terminalWordSeparator: value || undefined })
                }}
                placeholder={` ()[]{},'"\``}
                className="w-56 font-mono text-xs"
              />
            }
          />
        </SearchableSetting>

        {showWindowsPowerShellImplementation &&
        matchesSettingsSearch(
          searchQuery,
          getTerminalWindowsPowershellImplementationSearchEntry()
        ) ? (
          <SearchableSetting
            title={translate(
              'auto.components.settings.TerminalPane.fe20f79dd1',
              'PowerShell Version'
            )}
            description={translate(
              'auto.components.settings.TerminalPane.3d88af864d',
              'Choose whether the PowerShell shell option launches Windows PowerShell or PowerShell 7+ for new terminal panes.'
            )}
            keywords={[
              'terminal',
              'windows',
              'powershell',
              'pwsh',
              'powershell 7',
              'windows powershell',
              'version',
              'advanced'
            ]}
          >
            <SettingsRow
              alignTop
              label={translate(
                'auto.components.settings.TerminalPane.fe20f79dd1',
                'PowerShell Version'
              )}
              description={
                pwshAvailable ? (
                  translate(
                    'auto.components.settings.TerminalPane.5ed5c95344',
                    'Choose between Windows PowerShell and PowerShell 7+ for new terminal panes.'
                  )
                ) : (
                  <>
                    {translate(
                      'auto.components.settings.TerminalPane.a016ffbeed',
                      'Auto uses Windows PowerShell now and switches to PowerShell 7+ when installed.'
                    )}{' '}
                    <a
                      href="https://github.com/PowerShell/PowerShell/releases/latest"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline hover:text-foreground"
                    >
                      {translate(
                        'auto.components.settings.TerminalPane.822f62ddcd',
                        'Download PowerShell 7+'
                      )}
                    </a>
                    .
                  </>
                )
              }
              control={
                <SettingsSegmentedControl
                  ariaLabel={translate(
                    'auto.components.settings.TerminalPane.fe20f79dd1',
                    'PowerShell Version'
                  )}
                  value={powerShellImplementation}
                  onChange={(value) =>
                    updateSettings({ terminalWindowsPowerShellImplementation: value })
                  }
                  options={[
                    {
                      value: 'auto',
                      label: translate('auto.components.settings.TerminalPane.43c2ff7b0e', 'Auto')
                    },
                    {
                      value: 'powershell.exe',
                      label: translate(
                        'auto.components.settings.TerminalPane.d26174e1dd',
                        'Windows PowerShell'
                      )
                    },
                    {
                      value: 'pwsh.exe',
                      label: translate(
                        'auto.components.settings.TerminalPane.96be03b8eb',
                        'PowerShell 7+'
                      ),
                      disabled: !pwshAvailable
                    }
                  ]}
                />
              }
            />
          </SearchableSetting>
        ) : null}

        {isMac ? (
          <TerminalMacKeyboardSection settings={settings} updateSettings={updateSettings} />
        ) : null}
      </div>
    </section>
  )
}

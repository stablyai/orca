import { TerminalLimitSetting } from './TerminalLimitSetting'
import type { SettingsHostScope } from './settings-host-scope'
import { useState } from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { TERMINAL_DEFAULT_WORD_SEPARATOR } from '../../../../shared/terminal-word-separator'
import {
  DESKTOP_TERMINAL_SCROLLBACK_ROWS_MAX,
  DESKTOP_TERMINAL_SCROLLBACK_ROWS_MIN,
  normalizeDesktopTerminalScrollbackRows
} from '../../../../shared/terminal-scrollback-policy'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group'
import {
  SettingsRow,
  SettingsSegmentedControl,
  SettingsSubsectionHeader
} from './SettingsFormControls'
import { SCROLLBACK_PRESETS_ROWS } from './SettingsConstants'
import { SearchableSetting } from './SearchableSetting'
import { matchesSettingsSearch } from './settings-search'
import { getTerminalWindowsPowershellImplementationSearchEntry } from './terminal-windows-search'
import { TerminalMacKeyboardSection } from './TerminalMacKeyboardSection'
import { translate } from '@/i18n/i18n'
import { openAppHttpLinkFromAnchor } from '@/lib/app-http-link-open'

type TerminalAdvancedSectionProps = {
  hostScope?: SettingsHostScope
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  scrollbackMode: 'preset' | 'custom'
  setScrollbackMode: (mode: 'preset' | 'custom') => void
  searchQuery: string
  showWindowsPowerShellImplementation: boolean
  pwshAvailable?: boolean
  isMac: boolean
}

function formatScrollbackRowsLabel(rows: number): string {
  return rows % 1_000 === 0 ? `${rows / 1_000}k` : String(rows)
}

function toWordSeparatorSetting(draft: string): string | undefined {
  return draft && draft !== TERMINAL_DEFAULT_WORD_SEPARATOR ? draft : undefined
}

export function TerminalAdvancedSection({
  hostScope,
  settings,
  updateSettings,
  scrollbackMode,
  setScrollbackMode,
  searchQuery,
  showWindowsPowerShellImplementation,
  pwshAvailable,
  isMac
}: TerminalAdvancedSectionProps): React.JSX.Element {
  const scrollbackRows = normalizeDesktopTerminalScrollbackRows(settings.terminalScrollbackRows)
  const [scrollbackRowsDraft, setScrollbackRowsDraft] = useState(String(scrollbackRows))
  const [prevScrollbackRows, setPrevScrollbackRows] = useState(scrollbackRows)
  if (scrollbackRows !== prevScrollbackRows) {
    // Adopt external settings changes without replacing drafts during active edits.
    setPrevScrollbackRows(scrollbackRows)
    setScrollbackRowsDraft(String(scrollbackRows))
  }
  const isPreset = SCROLLBACK_PRESETS_ROWS.includes(
    scrollbackRows as (typeof SCROLLBACK_PRESETS_ROWS)[number]
  )
  const scrollbackToggleValue =
    scrollbackMode === 'custom' ? 'custom' : isPreset ? `${scrollbackRows}` : 'custom'
  const wordSeparator = settings.terminalWordSeparator
  const [wordSeparatorDraft, setWordSeparatorDraft] = useState(
    wordSeparator ?? TERMINAL_DEFAULT_WORD_SEPARATOR
  )
  const [prevWordSeparator, setPrevWordSeparator] = useState(wordSeparator)
  if (wordSeparator !== prevWordSeparator) {
    setPrevWordSeparator(wordSeparator)
    // Why: an emptied field stays empty while editing instead of snapping back to the default.
    if (wordSeparator !== toWordSeparatorSetting(wordSeparatorDraft)) {
      setWordSeparatorDraft(wordSeparator ?? TERMINAL_DEFAULT_WORD_SEPARATOR)
    }
  }
  const commitWordSeparatorDraft = (draft: string): void => {
    setWordSeparatorDraft(draft)
    updateSettings({ terminalWordSeparator: toWordSeparatorSetting(draft) })
  }
  const powerShellImplementation = settings.terminalWindowsPowerShellImplementation ?? 'auto'
  const commitScrollbackRowsDraft = (): void => {
    const trimmed = scrollbackRowsDraft.trim()
    const value = Number(trimmed)
    if (trimmed === '' || !Number.isFinite(value)) {
      setScrollbackRowsDraft(String(scrollbackRows))
      return
    }

    const next = normalizeDesktopTerminalScrollbackRows(value)
    updateSettings({ terminalScrollbackRows: next })
    setScrollbackRowsDraft(String(next))
  }

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
          title={translate('auto.components.settings.TerminalPane.9df53f7c14', 'Scrollback Rows')}
          description={translate(
            'auto.components.settings.TerminalPane.c3810b2b42',
            'Retained desktop terminal rows.'
          )}
          keywords={['terminal', 'scrollback', 'rows', 'buffer', 'memory']}
        >
          <SettingsRow
            alignTop={scrollbackMode === 'custom'}
            label={translate('auto.components.settings.TerminalPane.9df53f7c14', 'Scrollback Rows')}
            description={translate(
              'auto.components.settings.TerminalPane.81d86b2dd2',
              'Retained desktop terminal rows for new and open panes.'
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
                      terminalScrollbackRows: normalizeDesktopTerminalScrollbackRows(Number(value))
                    })
                  }}
                  variant="outline"
                  size="sm"
                  className="h-8 flex-wrap justify-end"
                >
                  {SCROLLBACK_PRESETS_ROWS.map((preset) => (
                    <ToggleGroupItem
                      key={preset}
                      value={`${preset}`}
                      className="h-8 px-3 text-xs"
                      aria-label={translate(
                        'auto.components.settings.TerminalPane.5336c096af',
                        '{{value0}} rows',
                        { value0: preset }
                      )}
                    >
                      {formatScrollbackRowsLabel(preset)}
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
                      min={DESKTOP_TERMINAL_SCROLLBACK_ROWS_MIN}
                      max={DESKTOP_TERMINAL_SCROLLBACK_ROWS_MAX}
                      step={100}
                      value={scrollbackRowsDraft}
                      onChange={(e) => setScrollbackRowsDraft(e.target.value)}
                      onBlur={commitScrollbackRowsDraft}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          commitScrollbackRowsDraft()
                        }
                      }}
                      className="number-input-clean w-24 tabular-nums"
                    />
                    <span className="text-xs text-muted-foreground">
                      {translate('auto.components.settings.TerminalPane.12e06178fa', 'rows')}
                    </span>
                  </div>
                ) : null}
              </div>
            }
          />
        </SearchableSetting>

        {hostScope ? <TerminalLimitSetting scope={hostScope} /> : null}

        <SearchableSetting
          title={translate('auto.components.settings.TerminalPane.4bebcc2b2c', 'Word Separators')}
          description={translate(
            'settings.terminal.wordSeparators.description',
            'Characters treated as word boundaries for double-click selection, including space.'
          )}
          keywords={['word', 'separator', 'boundary', 'double-click', 'selection']}
        >
          <SettingsRow
            label={translate('auto.components.settings.TerminalPane.4bebcc2b2c', 'Word Separators')}
            description={translate(
              'settings.terminal.wordSeparators.description',
              'Characters treated as word boundaries for double-click selection, including space.'
            )}
            control={
              <div className="flex w-56 flex-col items-end gap-1">
                <div className="flex w-full items-center gap-1">
                  <Input
                    value={wordSeparatorDraft}
                    onChange={(e) => commitWordSeparatorDraft(e.target.value)}
                    variant="code"
                    spellCheck={false}
                    className="min-w-0 flex-1"
                  />
                  {wordSeparatorDraft !== TERMINAL_DEFAULT_WORD_SEPARATOR ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={() => commitWordSeparatorDraft(TERMINAL_DEFAULT_WORD_SEPARATOR)}
                    >
                      {translate('auto.components.settings.AgentsPane.5200dac9da', 'Reset')}
                    </Button>
                  ) : null}
                </div>
                {wordSeparatorDraft && !wordSeparatorDraft.includes(' ') ? (
                  <p className="text-xs text-status-warning">
                    {translate(
                      'settings.terminal.wordSeparators.noSpaceHint',
                      'No space included — double-click will select across spaces.'
                    )}
                  </p>
                ) : null}
              </div>
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
                      onClick={openAppHttpLinkFromAnchor}
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

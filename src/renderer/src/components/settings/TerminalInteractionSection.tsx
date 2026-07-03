import type { GlobalSettings } from '../../../../shared/types'
import { RotateCcw } from 'lucide-react'
import { Slider } from '../ui/slider'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { SettingsSubsectionHeader, SettingsSwitchRow } from './SettingsFormControls'
import { SearchableSetting } from './SearchableSetting'
import { matchesSettingsSearch } from './settings-search'
import { getTerminalRightClickToPasteSearchEntry } from './terminal-windows-search'
import { OSC52_CLIPBOARD_SETTING_ID } from '../terminal-pane/osc52-clipboard-setting-anchor'
import { translate } from '@/i18n/i18n'
import {
  DEFAULT_TERMINAL_FAST_SCROLL_SENSITIVITY,
  DEFAULT_TERMINAL_SCROLL_SENSITIVITY,
  normalizeTerminalFastScrollSensitivity,
  normalizeTerminalScrollSensitivity
} from '@/lib/pane-manager/pane-terminal-options'
import {
  TERMINAL_TUI_MOUSE_WHEEL_MULTIPLIER,
  normalizeTerminalTuiMouseWheelMultiplier
} from '@/lib/pane-manager/pane-terminal-mouse-wheel'

type TerminalInteractionSectionProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  searchQuery: string
  isWindows: boolean
}

type ScrollSpeedSliderProps = {
  label: string
  description: string
  value: number
  min: number
  max: number
  step: number
  suffix: string
  onChange: (value: number) => void
}

function formatScrollSpeedValue(value: number): string {
  return Number.isInteger(value)
    ? String(value)
    : value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')
}

function ScrollSpeedSlider({
  label,
  description,
  value,
  min,
  max,
  step,
  suffix,
  onChange
}: ScrollSpeedSliderProps): React.JSX.Element {
  return (
    <div className="rounded-md border border-border/60 bg-background/50 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <Label className="text-xs font-medium">{label}</Label>
          <p className="text-[11px] leading-4 text-muted-foreground">{description}</p>
        </div>
        <span className="shrink-0 rounded-md border border-border/50 bg-muted/40 px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-foreground">
          {formatScrollSpeedValue(value)}
          {suffix}
        </span>
      </div>
      <Slider
        className="mt-3"
        min={min}
        max={max}
        step={step}
        value={[value]}
        onValueChange={([next]) => {
          if (next !== undefined) {
            onChange(next)
          }
        }}
      />
      <div className="mt-1 flex justify-between font-mono text-[10px] text-muted-foreground">
        <span>{formatScrollSpeedValue(min)}</span>
        <span>{formatScrollSpeedValue(max)}</span>
      </div>
    </div>
  )
}

export function TerminalInteractionSection({
  settings,
  updateSettings,
  searchQuery,
  isWindows
}: TerminalInteractionSectionProps): React.JSX.Element {
  return (
    <section key="pane-interaction" className="space-y-3">
      <SettingsSubsectionHeader
        title={translate(
          'auto.components.settings.TerminalPane.45721f3e67',
          'Terminal Interaction'
        )}
        description={translate(
          'auto.components.settings.TerminalPane.96fe15def8',
          'Mouse and clipboard behavior for terminal panes.'
        )}
      />

      <div className="divide-y divide-border/40">
        <SearchableSetting
          title={translate(
            'auto.components.settings.TerminalPane.scrollSpeed.title',
            'Scroll Speed'
          )}
          description={translate(
            'auto.components.settings.TerminalPane.scrollSpeed.description',
            'Tune normal terminal scrollback, fast modifier scrolling, and full-screen TUI wheel speed.'
          )}
          keywords={[
            'terminal',
            'scroll',
            'scrolling',
            'speed',
            'wheel',
            'mouse',
            'trackpad',
            'tui',
            'opencode',
            'fast scroll'
          ]}
        >
          <div className="space-y-3 py-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="space-y-0.5">
                <Label>
                  {translate(
                    'auto.components.settings.TerminalPane.scrollSpeed.title',
                    'Scroll Speed'
                  )}
                </Label>
                <p className="max-w-xl text-xs text-muted-foreground">
                  {translate(
                    'auto.components.settings.TerminalPane.scrollSpeed.helper',
                    'Adjust how wheel input feels in scrollback and in mouse-aware terminal apps.'
                  )}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() =>
                  updateSettings({
                    terminalScrollSensitivity: DEFAULT_TERMINAL_SCROLL_SENSITIVITY,
                    terminalFastScrollSensitivity: DEFAULT_TERMINAL_FAST_SCROLL_SENSITIVITY,
                    terminalTuiScrollSensitivity: TERMINAL_TUI_MOUSE_WHEEL_MULTIPLIER
                  })
                }
              >
                <RotateCcw className="size-3.5" />
                {translate('auto.components.settings.TerminalPane.scrollSpeed.reset', 'Reset')}
              </Button>
            </div>
            <div className="grid gap-3 md:grid-cols-3">
              <ScrollSpeedSlider
                label={translate(
                  'auto.components.settings.TerminalPane.scrollSpeed.normal',
                  'Normal'
                )}
                description={translate(
                  'auto.components.settings.TerminalPane.scrollSpeed.normalDescription',
                  'Scrollback wheel multiplier.'
                )}
                value={normalizeTerminalScrollSensitivity(settings.terminalScrollSensitivity)}
                min={0.5}
                max={3}
                step={0.05}
                suffix="x"
                onChange={(value) =>
                  updateSettings({
                    terminalScrollSensitivity: normalizeTerminalScrollSensitivity(value)
                  })
                }
              />
              <ScrollSpeedSlider
                label={translate('auto.components.settings.TerminalPane.scrollSpeed.fast', 'Fast')}
                description={translate(
                  'auto.components.settings.TerminalPane.scrollSpeed.fastDescription',
                  'Extra multiplier while scrolling with a modifier key.'
                )}
                value={normalizeTerminalFastScrollSensitivity(
                  settings.terminalFastScrollSensitivity
                )}
                min={1}
                max={10}
                step={0.5}
                suffix="x"
                onChange={(value) =>
                  updateSettings({
                    terminalFastScrollSensitivity: normalizeTerminalFastScrollSensitivity(value)
                  })
                }
              />
              <ScrollSpeedSlider
                label={translate('auto.components.settings.TerminalPane.scrollSpeed.tui', 'TUI')}
                description={translate(
                  'auto.components.settings.TerminalPane.scrollSpeed.tuiDescription',
                  'Discrete wheel reports for full-screen terminal apps.'
                )}
                value={normalizeTerminalTuiMouseWheelMultiplier(
                  settings.terminalTuiScrollSensitivity
                )}
                min={1}
                max={10}
                step={1}
                suffix="x"
                onChange={(value) =>
                  updateSettings({
                    terminalTuiScrollSensitivity: normalizeTerminalTuiMouseWheelMultiplier(value)
                  })
                }
              />
            </div>
          </div>
        </SearchableSetting>

        {/* Why: the Windows-only right-click toggle lives in this section, so the
            section must also match that search term or settings search would hide
            the control even though it is present. */}
        {isWindows &&
        matchesSettingsSearch(searchQuery, getTerminalRightClickToPasteSearchEntry()) ? (
          <SearchableSetting
            title={translate(
              'auto.components.settings.TerminalPane.9c178cf8aa',
              'Right-click to paste'
            )}
            description={translate(
              'auto.components.settings.TerminalPane.af0c3b6e39',
              'On Windows, right-click pastes the clipboard into the terminal. Use Ctrl+right-click to open the context menu.'
            )}
            keywords={['terminal', 'windows', 'right click', 'paste', 'context menu']}
          >
            <SettingsSwitchRow
              label={translate(
                'auto.components.settings.TerminalPane.9c178cf8aa',
                'Right-click to paste'
              )}
              description={translate(
                'auto.components.settings.TerminalPane.16753eea48',
                'On Windows, right-click pastes the clipboard. Ctrl+right-click opens the context menu.'
              )}
              checked={settings.terminalRightClickToPaste}
              onChange={() =>
                updateSettings({
                  terminalRightClickToPaste: !settings.terminalRightClickToPaste
                })
              }
            />
          </SearchableSetting>
        ) : null}

        <SearchableSetting
          title={translate(
            'auto.components.settings.TerminalPane.8eefeaa3da',
            'Focus Follows Mouse'
          )}
          description={translate(
            'auto.components.settings.TerminalPane.9129b7e805',
            'Hovering a terminal pane activates it without needing to click.'
          )}
          keywords={['focus', 'follows', 'mouse', 'hover', 'pane', 'ghostty', 'active']}
        >
          <SettingsSwitchRow
            label={translate(
              'auto.components.settings.TerminalPane.8eefeaa3da',
              'Focus Follows Mouse'
            )}
            description={translate(
              'auto.components.settings.TerminalPane.9129b7e805',
              'Hovering a terminal pane activates it without needing to click.'
            )}
            checked={settings.terminalFocusFollowsMouse}
            onChange={() =>
              updateSettings({
                terminalFocusFollowsMouse: !settings.terminalFocusFollowsMouse
              })
            }
          />
        </SearchableSetting>

        <SearchableSetting
          title={translate('auto.components.settings.TerminalPane.902f5dee1f', 'Copy on Select')}
          description={translate(
            'auto.components.settings.TerminalPane.4729c645fc',
            'Automatically copy terminal selections to the clipboard.'
          )}
          keywords={[
            'clipboard',
            'copy',
            'select',
            'selection',
            'auto',
            'automatic',
            'x11',
            'linux',
            'gnome',
            'paste'
          ]}
        >
          <SettingsSwitchRow
            label={translate('auto.components.settings.TerminalPane.902f5dee1f', 'Copy on Select')}
            description={translate(
              'auto.components.settings.TerminalPane.4729c645fc',
              'Automatically copy terminal selections to the clipboard.'
            )}
            checked={settings.terminalClipboardOnSelect}
            onChange={() =>
              updateSettings({
                terminalClipboardOnSelect: !settings.terminalClipboardOnSelect
              })
            }
          />
        </SearchableSetting>

        <SearchableSetting
          id={OSC52_CLIPBOARD_SETTING_ID}
          title={translate(
            'auto.components.settings.TerminalPane.3338dcf8c1',
            'Allow TUI Clipboard Writes (OSC 52)'
          )}
          description={translate(
            'auto.components.settings.TerminalPane.69c64a479c',
            'Let tmux, Neovim, and fzf copy to the system clipboard over the PTY (including over SSH).'
          )}
          keywords={[
            'osc 52',
            'osc52',
            'clipboard',
            'tmux',
            'neovim',
            'nvim',
            'fzf',
            'ssh',
            'remote',
            'copy',
            'paste'
          ]}
        >
          <SettingsSwitchRow
            label={translate(
              'auto.components.settings.TerminalPane.3338dcf8c1',
              'Allow TUI Clipboard Writes (OSC 52)'
            )}
            description={translate(
              'auto.components.settings.TerminalPane.6e6480a7df',
              'Let programs in the terminal (tmux, Neovim, fzf, SSH) copy to your system clipboard.'
            )}
            checked={settings.terminalAllowOsc52Clipboard}
            onChange={() =>
              updateSettings({
                terminalAllowOsc52Clipboard: !settings.terminalAllowOsc52Clipboard
              })
            }
          />
        </SearchableSetting>
      </div>
    </section>
  )
}

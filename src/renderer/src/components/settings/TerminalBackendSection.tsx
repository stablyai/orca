import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import { Input } from '../ui/input'
import {
  SettingsRow,
  SettingsSegmentedControl,
  SettingsSubsectionHeader
} from './SettingsFormControls'

type TerminalBackendSectionProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function TerminalBackendSection({
  settings,
  updateSettings
}: TerminalBackendSectionProps): React.JSX.Element {
  return (
    <section className="space-y-3">
      <SettingsSubsectionHeader
        title={translate(
          'auto.components.settings.TerminalBackendSection.title',
          'Terminal runtime'
        )}
        description={translate(
          'auto.components.settings.TerminalBackendSection.description',
          'Choose which runtime owns new project terminal sessions.'
        )}
      />
      <div className="divide-y divide-border/40">
        <SettingsRow
          label={translate(
            'auto.components.settings.TerminalBackendSection.defaultBackend',
            'Default backend'
          )}
          description={translate(
            'auto.components.settings.TerminalBackendSection.defaultDescription',
            'Existing projects keep their active backend until you migrate them explicitly.'
          )}
          control={
            <SettingsSegmentedControl
              ariaLabel={translate(
                'auto.components.settings.TerminalBackendSection.defaultAria',
                'Default terminal backend'
              )}
              value={settings.terminalBackendDefault ?? 'orca'}
              onChange={(value) =>
                updateSettings({ terminalBackendDefault: value as 'orca' | 'herdr' })
              }
              options={[
                {
                  value: 'orca',
                  label: translate('auto.components.settings.TerminalBackendSection.orca', 'Orca')
                },
                {
                  value: 'herdr',
                  label: translate('auto.components.settings.TerminalBackendSection.herdr', 'Herdr')
                }
              ]}
            />
          }
        />
        {settings.terminalBackendDefault === 'herdr' ? (
          <SettingsRow
            label={translate(
              'auto.components.settings.TerminalBackendSection.runtime',
              'Herdr runtime'
            )}
            description={translate(
              'auto.components.settings.TerminalBackendSection.runtimeDescription',
              'Stock from PATH starts or attaches to herdr --session orca so Ghostty and other Herdr clients see the same session. Built-in daemon is a private fallback that those clients cannot attach to.'
            )}
            control={
              <SettingsSegmentedControl
                ariaLabel={translate(
                  'auto.components.settings.TerminalBackendSection.runtimeAria',
                  'Herdr runtime source'
                )}
                value={settings.herdrRuntimeSource ?? 'stock'}
                onChange={(value) =>
                  updateSettings({ herdrRuntimeSource: value as 'daemon' | 'stock' })
                }
                options={[
                  {
                    value: 'daemon',
                    label: translate(
                      'auto.components.settings.TerminalBackendSection.daemon',
                      'Built-in daemon'
                    )
                  },
                  {
                    value: 'stock',
                    label: translate(
                      'auto.components.settings.TerminalBackendSection.stock',
                      'Stock from PATH'
                    )
                  }
                ]}
              />
            }
          />
        ) : null}
        <SettingsRow
          label={translate(
            'auto.components.settings.TerminalBackendSection.installation',
            'Herdr installation'
          )}
          description={translate(
            'auto.components.settings.TerminalBackendSection.installationDescription',
            'From PATH resolves the stock Herdr executable on each execution host.'
          )}
          control={
            <SettingsSegmentedControl
              ariaLabel={translate(
                'auto.components.settings.TerminalBackendSection.installationAria',
                'Herdr installation source'
              )}
              value={settings.herdrBinarySource?.kind ?? 'system'}
              onChange={(value) => {
                if (value === 'custom') {
                  updateSettings({ herdrBinarySource: { kind: 'custom', path: '' } })
                  return
                }
                updateSettings({ herdrBinarySource: { kind: 'system' } })
              }}
              options={[
                {
                  value: 'system',
                  label: translate(
                    'auto.components.settings.TerminalBackendSection.system',
                    'From PATH'
                  )
                },
                {
                  value: 'custom',
                  label: translate(
                    'auto.components.settings.TerminalBackendSection.custom',
                    'Custom'
                  )
                }
              ]}
            />
          }
        />
        {settings.herdrBinarySource?.kind === 'custom' ? (
          <SettingsRow
            label={translate(
              'auto.components.settings.TerminalBackendSection.customPath',
              'Custom Herdr path'
            )}
            description={translate(
              'auto.components.settings.TerminalBackendSection.customPathDescription',
              'Absolute executable path on the execution host.'
            )}
            control={
              <Input
                aria-label={translate(
                  'auto.components.settings.TerminalBackendSection.customPathAria',
                  'Custom Herdr executable path'
                )}
                value={settings.herdrBinarySource.path}
                placeholder={translate(
                  'auto.components.settings.TerminalBackendSection.customPathPlaceholder',
                  '/usr/local/bin/herdr'
                )}
                className="w-72"
                onChange={(event) =>
                  updateSettings({
                    herdrBinarySource: { kind: 'custom', path: event.target.value }
                  })
                }
                onBlur={(event) => {
                  if (!event.target.value.trim()) {
                    updateSettings({ herdrBinarySource: { kind: 'system' } })
                  }
                }}
              />
            }
          />
        ) : null}
        <SettingsRow
          label={translate(
            'auto.components.settings.TerminalBackendSection.sessionName',
            'Shared Herdr session name'
          )}
          description={translate(
            'auto.components.settings.TerminalBackendSection.sessionNameDescription',
            'All projects without an explicit override share this stock Herdr session. Clear it to fall back to per-project sessions.'
          )}
          control={
            <Input
              aria-label={translate(
                'auto.components.settings.TerminalBackendSection.sessionNameAria',
                'Shared Herdr session name'
              )}
              value={settings.herdrSessionName ?? ''}
              placeholder={translate(
                'auto.components.settings.TerminalBackendSection.sessionNamePlaceholder',
                'orca'
              )}
              maxLength={64}
              className="w-72"
              onChange={(event) => updateSettings({ herdrSessionName: event.target.value })}
              onBlur={(event) => updateSettings({ herdrSessionName: event.target.value.trim() })}
            />
          }
        />
      </div>
    </section>
  )
}

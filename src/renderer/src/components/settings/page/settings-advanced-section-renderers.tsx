import { lazy, Suspense } from 'react'
import { AdvancedPane } from '../advanced/AdvancedPane'
import { ExperimentalPane } from '../advanced/ExperimentalPane'
import { PluginsSettingsSection } from '../../plugins/list/PluginsSettingsSection'
import { SettingsSection } from '../section-layout/SettingsSection'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { SettingsRenderContext } from './settings-render-context'

const DevToolsPane = import.meta.env.DEV
  ? lazy(() =>
      import('../advanced/DevToolsPane').then((module) => ({ default: module.DevToolsPane }))
    )
  : null

export function renderAdvancedSettingsSection(
  context: SettingsRenderContext,
  t: Translate = translate
): React.JSX.Element | null {
  const { model, navigation, view } = context
  return model.showDesktopOnlySettings ? (
    <SettingsSection
      id="advanced"
      title={t('auto.components.settings.Settings.1c87f8d024', 'Advanced')}
      description={t(
        'auto.components.settings.Settings.499c1cd7f9',
        'Low-level compatibility settings for troubleshooting.'
      )}
      searchEntries={navigation.getSectionSearchEntries('advanced')}
    >
      {view.isSectionMounted('advanced') ? (
        <AdvancedPane settings={model.settings} updateSettings={model.updateSettings} />
      ) : null}
    </SettingsSection>
  ) : null
}

export function renderDevSettingsSection(
  context: SettingsRenderContext,
  t: Translate = translate
): React.JSX.Element | null {
  const { model, navigation, view } = context
  return model.showDesktopOnlySettings && import.meta.env.DEV ? (
    <SettingsSection
      id="dev"
      title={t('auto.components.settings.Settings.3eac6fb97f', 'Dev tools')}
      description={t(
        'auto.components.settings.Settings.devDescription',
        'Dev-only tools for exercising UI states.'
      )}
      searchEntries={navigation.getSectionSearchEntries('dev')}
    >
      {DevToolsPane && view.isSectionMounted('dev') ? (
        <Suspense fallback={null}>
          <DevToolsPane />
        </Suspense>
      ) : null}
    </SettingsSection>
  ) : null
}

export function renderExperimentalSettingsSection(
  context: SettingsRenderContext,
  t: Translate = translate
): React.JSX.Element {
  const { model, navigation, view } = context
  return (
    <SettingsSection
      id="experimental"
      title={t('auto.components.settings.Settings.8b017f2506', 'Experimental')}
      description={t(
        'auto.components.settings.Settings.075341c763',
        'New features that are still taking shape. Give them a try.'
      )}
      searchEntries={navigation.getSectionSearchEntries('experimental')}
      // Option-click unlocks hidden staff controls for this session, matching Updates.
      onTitleClick={(event) => {
        if (event.altKey) {
          model.setHiddenExperimentalUnlocked((previous) => !previous)
        }
      }}
    >
      {view.isSectionMounted('experimental') ? (
        <ExperimentalPane
          settings={model.settings}
          updateSettings={model.updateSettings}
          hiddenExperimentalUnlocked={model.hiddenExperimentalUnlocked}
        />
      ) : null}
    </SettingsSection>
  )
}

export function renderPluginsSettingsSection(
  context: SettingsRenderContext
): React.JSX.Element | null {
  const { model, view } = context
  return model.showDesktopOnlySettings ? (
    <PluginsSettingsSection
      mounted={view.isSectionMounted('plugins')}
      settings={model.settings}
      updateSettings={model.updateSettingsOrThrow}
    />
  ) : null
}

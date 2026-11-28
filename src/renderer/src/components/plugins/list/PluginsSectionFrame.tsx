import { useCallback } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { useMobilePageEscape } from '@/components/mobile/use-mobile-page-escape'
import { RailPage, RailPageScroll } from '@/components/rail-page/RailPage'
import { RailPageHeader } from '@/components/rail-page/RailPageHeader'
import { SettingsSection } from '../../settings/section-layout/SettingsSection'
import { getPluginsSectionPresentation } from '../../settings/plugins/plugins-search'
import { PluginsSectionDescription } from './PluginsSectionDescription'
import type { PluginPageNavigation } from '../state/use-plugin-page-navigation'

/** Plugins' one body in either home: the Settings pane, or the app rail page's header and gutters. */
export function PluginsSectionFrame({
  railPage,
  page,
  featureEnabled,
  count,
  headerAction,
  children
}: {
  railPage: { onClose: () => void } | undefined
  page: Pick<PluginPageNavigation, 'openKey' | 'back'>
  featureEnabled: boolean
  count: number | null
  headerAction: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  const presentation = getPluginsSectionPresentation(t)
  const onClose = railPage?.onClose
  // A plugin's own page is showing instead of the catalog.
  const pageOpen = featureEnabled && page.openKey !== null
  const onBack = page.back
  // Why: on the rail page Esc steps back from a plugin's page before it leaves Plugins.
  const escape = useCallback(() => (pageOpen ? onBack() : onClose?.()), [pageOpen, onBack, onClose])
  useMobilePageEscape(onClose ? escape : null)
  if (!onClose) {
    return (
      <SettingsSection
        id="plugins"
        {...presentation}
        description={<PluginsSectionDescription text={presentation.description} />}
        hideHeader={pageOpen}
        bodyClassName="gap-6"
        headerAction={headerAction}
      >
        {children}
      </SettingsSection>
    )
  }
  return (
    <RailPage as="main" aria-label={presentation.title} data-plugins-page="">
      {/* Like Settings, a plugin's own page brings its own header and actions. */}
      {pageOpen ? null : (
        <RailPageHeader
          title={presentation.title}
          count={count}
          close={{
            label: t('auto.components.plugins.PluginsPage.close', 'Close plugins'),
            tooltip: t('auto.components.skills.SkillsPage.closeTooltip', 'Close · Esc'),
            onClose
          }}
          actions={headerAction}
        />
      )}
      <RailPageScroll as="section" className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto">
        <div className="rail-page-row-gutter flex flex-col gap-6 py-6">{children}</div>
      </RailPageScroll>
    </RailPage>
  )
}

import { useId } from 'react'
import type { GlobalSettings } from '../../../../../../shared/settings/global-settings-types'
import { BROWSER_OPEN_LINKS_SETTINGS_TARGET_ID } from '@/components/settings/navigation/settings-navigation-types'
import { Label } from '../../../ui/label'
import { SearchableSetting } from '../../section-layout/SearchableSetting'
import { SettingsSegmentedControl } from '../../form-controls/SettingsFormControls'
import { useTranslate } from '@/i18n/use-translate'
import type { HttpLinkDestination } from '@/lib/browser/navigation/http-link-destinations'
import { httpLinkModeFor } from '@/lib/links/preferences/http-link-mode'
import {
  beginLinkPreferenceOperation,
  writeLinkPreference
} from '@/lib/links/preferences/link-preference-operation'
import { storeLinkPreferenceWriter } from '@/lib/links/preferences/link-preference-store-writer'
import type { LinkPreferenceFields } from '@/lib/links/preferences/link-preference-publication'
import { getBrowserOpenLinksCopy } from './browser-link-routing-copy'

type OpenLinksChoice = 'ask' | HttpLinkDestination

function choiceFor(settings: GlobalSettings): OpenLinksChoice {
  if (httpLinkModeFor(settings) === 'ask') {
    return 'ask'
  }
  return settings.openLinksInApp ? 'orca' : 'system'
}

function fieldsForChoice(choice: OpenLinksChoice): LinkPreferenceFields {
  if (choice === 'ask') {
    return { httpLinkClickBehavior: 'ask', openLinksInAppPreferencePrompted: true }
  }
  return {
    httpLinkClickBehavior: 'open',
    openLinksInApp: choice === 'orca',
    openLinksInAppPreferencePrompted: true
  }
}

/** Every link-preference write here starts a new operation, which supersedes any pending Remember. */
function writeChoice(fields: LinkPreferenceFields): void {
  void writeLinkPreference(beginLinkPreferenceOperation('settings', fields), storeLinkPreferenceWriter)
}

// Controls sit under their label so long localized options wrap instead of crushing the description.
function StackedChoiceRow({
  label,
  description,
  children,
  className
}: {
  label: string
  description: string
  children: (labelId: string, descriptionId: string) => React.ReactNode
  className?: string
}): React.JSX.Element {
  const labelId = useId()
  const descriptionId = useId()
  return (
    <div className={className ?? 'space-y-2 py-3'}>
      <div className="space-y-1">
        <Label id={labelId} className="select-text">
          {label}
        </Label>
        <p id={descriptionId} className="select-text text-xs text-muted-foreground">
          {description}
        </p>
      </div>
      {children(labelId, descriptionId)}
    </div>
  )
}

export function BrowserOpenLinksSetting({
  settings,
  isMac
}: {
  settings: GlobalSettings
  isMac: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const copy = getBrowserOpenLinksCopy({ isMac }, t)
  const choice = choiceFor(settings)
  const orcaLabel = t('components.settings.browser.openLinks.orcaBrowser', 'Orca browser')
  const systemLabel = t('components.settings.browser.openLinks.systemBrowser', 'System browser')
  return (
    <SearchableSetting
      id={BROWSER_OPEN_LINKS_SETTINGS_TARGET_ID}
      title={copy.title}
      description={copy.description}
      keywords={copy.keywords}
    >
      <StackedChoiceRow label={copy.title} description={copy.description}>
        {(labelId, descriptionId) => (
          <SettingsSegmentedControl<OpenLinksChoice>
            value={choice}
            onChange={(value) => writeChoice(fieldsForChoice(value))}
            ariaLabelledBy={labelId}
            ariaDescribedBy={descriptionId}
            size="sm"
            wrap
            options={[
              { value: 'ask', label: t('components.settings.browser.openLinks.ask', 'Ask each time') },
              { value: 'orca', label: orcaLabel },
              { value: 'system', label: systemLabel }
            ]}
          />
        )}
      </StackedChoiceRow>
      {choice === 'ask' ? (
        <StackedChoiceRow
          className="mb-3 ml-0.5 space-y-2 border-l-2 border-border py-1 pl-3"
          label={t('components.settings.browser.openLinks.openDirectlyIn', 'Open directly in')}
          description={t(
            'components.settings.browser.openLinks.openDirectlyInDescription',
            '{{modifier}}-click and the first choice when Orca asks.',
            { modifier: isMac ? 'Cmd' : 'Ctrl' }
          )}
        >
          {(labelId, descriptionId) => (
            <SettingsSegmentedControl<HttpLinkDestination>
              value={settings.openLinksInApp ? 'orca' : 'system'}
              onChange={(value) =>
                writeChoice({ openLinksInApp: value === 'orca', openLinksInAppPreferencePrompted: true })
              }
              ariaLabelledBy={labelId}
              ariaDescribedBy={descriptionId}
              size="sm"
              wrap
              options={[
                { value: 'orca', label: orcaLabel },
                { value: 'system', label: systemLabel }
              ]}
            />
          )}
        </StackedChoiceRow>
      ) : null}
    </SearchableSetting>
  )
}

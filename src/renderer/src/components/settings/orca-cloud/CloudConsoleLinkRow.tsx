// "Manage in browser": one settings row that opens a web console page (team, billing, Enterprise).
// The settings themselves live in the console; the desktop only links there.
import { useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { openCloudConsole } from '@/lib/orca-cloud/open-cloud-console'
import type { OrcaCloudConsoleSection } from '../../../../../shared/orca-cloud-console'
import { SettingsRow } from '../form-controls/SettingsFormControls'
import { SettingsGroup } from '../section-layout/SettingsGroup'

export function CloudConsoleLinkRowView({
  label,
  description,
  busy,
  onOpen
}: {
  label: React.ReactNode
  description: React.ReactNode
  busy: boolean
  onOpen: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <SettingsGroup>
      <SettingsRow
        label={label}
        description={description}
        control={
          // A plain button, no "Copy link": the page opens signed in with a single-use code.
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-disabled={busy || undefined}
            onClick={busy ? undefined : onOpen}
          >
            {t('settings.cloudConsole.manageInBrowser', 'Manage in browser')}
            <ExternalLink />
          </Button>
        }
      />
    </SettingsGroup>
  )
}

export function CloudConsoleLinkRow({
  section,
  label,
  description
}: {
  section: OrcaCloudConsoleSection
  label: React.ReactNode
  description: React.ReactNode
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  return (
    <CloudConsoleLinkRowView
      label={label}
      description={description}
      busy={busy}
      onOpen={() => {
        setBusy(true)
        void openCloudConsole(section).finally(() => setBusy(false))
      }}
    />
  )
}

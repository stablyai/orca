import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { BrowserSessionProfile } from '../../../../../../shared/browser-workspace-types'
import type { GlobalSettings } from '../../../../../../shared/global-settings-types'
import { SearchableSetting } from '../../section-layout/SearchableSetting'
import { SettingsRow } from '../../form-controls/SettingsFormControls'
import { BrowserPasswordManagerDialog } from './BrowserPasswordManagerDialog'
import { getBrowserPasswordsDescription, getBrowserPasswordsTitle } from './browser-passwords-copy'

/** Browser settings entry point to the vault; shown only while the experiment is on. */
export function BrowserPasswordManagerSetting({
  settings,
  updateSettings,
  profiles
}: {
  settings: Pick<
    GlobalSettings,
    'browserPasswordsOfferToSave' | 'browserPasswordsFillRequiresReauth'
  >
  updateSettings: (updates: Partial<GlobalSettings>) => void
  profiles: BrowserSessionProfile[]
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const title = getBrowserPasswordsTitle()
  const description = getBrowserPasswordsDescription()
  return (
    <SearchableSetting
      title={title}
      description={description}
      keywords={['browser', 'passwords', 'logins', 'autofill', 'vault', 'import', 'csv']}
    >
      <SettingsRow
        label={title}
        description={description}
        control={
          <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(true)}>
            {translate('settings.browser.passwords.manage', 'Manage')}
          </Button>
        }
      />
      <BrowserPasswordManagerDialog
        open={open}
        onOpenChange={setOpen}
        profiles={profiles}
        settings={settings}
        updateSettings={updateSettings}
      />
    </SearchableSetting>
  )
}

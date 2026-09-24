import { useEffect } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { BROWSER_USER_AGENT_SETTINGS_TARGET_ID } from '@/lib/settings-navigation-types'

export function useBrowserIdentityMigrationNotice(): void {
  useEffect(() => {
    void window.api.browser
      .identityGet()
      .then((status) => {
        if (!status?.migrationNotice) {
          return
        }
        const description = status.migrationNotice.degraded
          ? translate(
              'browser.userAgentMigration.degradedDescription',
              'An old browser identity choice could not be inspected. Choose Cleaned or Native in Browser settings; changes take effect after a restart.'
            )
          : translate(
              'browser.userAgentMigration.description',
              'Per-profile user-agent settings were removed. Choose Cleaned or Native in Browser settings; changes take effect after a restart.'
            )
        toast.warning(
          translate('browser.userAgentMigration.title', 'Browser identity is now app-wide'),
          {
            description,
            duration: Infinity,
            action: {
              label: translate('browser.userAgentMigration.openSettings', 'Open Settings'),
              onClick: () => {
                const store = useAppStore.getState()
                store.openSettingsPage()
                store.openSettingsTarget({
                  pane: 'browser',
                  repoId: null,
                  sectionId: BROWSER_USER_AGENT_SETTINGS_TARGET_ID
                })
              }
            }
          }
        )
      })
      .catch(() => {})
  }, [])
}

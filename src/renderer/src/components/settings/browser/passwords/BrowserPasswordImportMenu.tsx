import { Fragment } from 'react'
import { ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'

// Families whose `Login Data` Orca can read; Firefox and Safari keep passwords elsewhere.
const CHROMIUM_FAMILIES = new Set(['chrome', 'chromium', 'arc', 'edge', 'comet', 'helium'])

export type BrowserPasswordImportSource = { browserFamily: string; profileDirectory: string }

export function BrowserPasswordImportMenu({
  disabled,
  onImportCsv,
  onImportBrowser
}: {
  disabled?: boolean
  onImportCsv: () => void
  onImportBrowser: (source: BrowserPasswordImportSource) => void
}): React.JSX.Element {
  const detectedBrowsers = useAppStore((s) => s.detectedBrowsers)
  const detectedBrowsersHost = useAppStore((s) => s.detectedBrowsersHost)
  const fetchDetectedBrowsers = useAppStore((s) => s.fetchDetectedBrowsers)
  // Only browsers on this computer: the vault never reads another machine's browser.
  const importableBrowsers =
    detectedBrowsersHost === null
      ? detectedBrowsers.filter((browser) => CHROMIUM_FAMILIES.has(browser.family))
      : []

  return (
    <DropdownMenu onOpenChange={(open) => open && void fetchDetectedBrowsers()}>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="xs" disabled={disabled}>
          {translate('settings.browser.passwords.import', 'Import')}
          <ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuItem onSelect={onImportCsv}>
          {translate('settings.browser.passwords.importCsv', 'From a CSV file…')}
        </DropdownMenuItem>
        {importableBrowsers.map((browser) => (
          <Fragment key={browser.family}>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>{browser.label}</DropdownMenuLabel>
            {browser.profiles.map((profile) => (
              <DropdownMenuItem
                key={profile.directory}
                onSelect={() =>
                  onImportBrowser({
                    browserFamily: browser.family,
                    profileDirectory: profile.directory
                  })
                }
              >
                {profile.name}
              </DropdownMenuItem>
            ))}
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

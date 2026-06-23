import { useState } from 'react'
import { Import, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import type { DetectedImportBrowser } from '../../../../shared/browser-credential-types'
import { Button } from '../ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
import { translate } from '@/i18n/i18n'

type PasswordImportButtonProps = {
  disabled: boolean
  onImported: () => void
}

export function PasswordImportButton({
  disabled,
  onImported
}: PasswordImportButtonProps): React.JSX.Element {
  const [detectedBrowsers, setDetectedBrowsers] = useState<DetectedImportBrowser[]>([])
  const [importing, setImporting] = useState(false)

  const handleOpenChange = (open: boolean): void => {
    if (open) {
      // Refresh the browser list each time the dropdown opens so newly
      // installed browsers appear without requiring a restart.
      void window.api.browser.credentials
        .detectImportBrowsers()
        .then(setDetectedBrowsers)
        .catch(() => {
          setDetectedBrowsers([])
          toast.error(
            translate(
              'auto.components.settings.passwordImport.detect_failed',
              'Could not detect supported browsers'
            )
          )
        })
    }
  }

  const handleImport = async (browserFamily: string, browserProfile?: string): Promise<void> => {
    setImporting(true)
    try {
      const result = await window.api.browser.credentials.importFromBrowser({
        browserFamily,
        browserProfile
      })
      if (result.ok) {
        toast.success(
          translate(
            'auto.components.settings.passwordImport.success_toast',
            'Imported {{value0}} logins from {{value1}}{{value2}}. {{value3}} skipped, {{value4}} invalid.',
            {
              value0: result.added,
              value1: result.browserLabel,
              value2: result.profileLabel ? ` (${result.profileLabel})` : '',
              value3: result.skipped,
              value4: result.invalid
            }
          )
        )
        onImported()
      } else {
        toast.error(result.reason)
      }
    } catch {
      toast.error(
        translate(
          'auto.components.settings.passwordImport.import_failed',
          'Import failed. Please try again.'
        )
      )
    } finally {
      setImporting(false)
    }
  }

  return (
    <DropdownMenu onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" disabled={disabled || importing} className="gap-1.5">
          {importing ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Import className="size-3.5" />
          )}
          {translate(
            'auto.components.settings.passwordImport.trigger_label',
            'Import from browser…'
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {detectedBrowsers.map((browser) =>
          browser.profiles.length > 1 ? (
            <DropdownMenuSub key={browser.family}>
              <DropdownMenuSubTrigger>
                {translate(
                  'auto.components.settings.passwordImport.from_browser',
                  'From {{value0}}',
                  { value0: browser.label }
                )}
              </DropdownMenuSubTrigger>
              <DropdownMenuPortal>
                <DropdownMenuSubContent>
                  {browser.profiles.map((profile) => (
                    <DropdownMenuItem
                      key={profile.directory}
                      onSelect={() => void handleImport(browser.family, profile.directory)}
                    >
                      {profile.name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuPortal>
            </DropdownMenuSub>
          ) : (
            <DropdownMenuItem
              key={browser.family}
              onSelect={() => void handleImport(browser.family)}
            >
              {translate(
                'auto.components.settings.passwordImport.from_browser',
                'From {{value0}}',
                { value0: browser.label }
              )}
            </DropdownMenuItem>
          )
        )}
        {detectedBrowsers.length === 0 ? (
          <DropdownMenuItem disabled>
            {translate(
              'auto.components.settings.passwordImport.no_browsers_found',
              'No supported browsers found'
            )}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

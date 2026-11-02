import { useState } from 'react'
import { webviewRegistry } from '../host-guest/webview-registry'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'

export function ClearBrowsingDataForm({
  pageId,
  onClearHistory,
  onClose
}: {
  pageId: string
  onClearHistory: (partition: string) => void
  onClose: () => void
}): React.JSX.Element {
  const [cookies, setCookies] = useState(false)
  const [cache, setCache] = useState(false)
  const [history, setHistory] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const clear = async (): Promise<void> => {
    setBusy(true)
    setError(false)
    try {
      const guestPartition = webviewRegistry.get(pageId)?.getAttribute('partition')
      if (!guestPartition) {
        throw new Error('Browser guest unavailable')
      }
      const partition = await window.api.browser.clearBrowsingData({
        partition: guestPartition,
        browserPageId: pageId,
        cookies,
        cache
      })
      if (history) {
        onClearHistory(partition)
      }
      onClose()
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent surface="security" scrollable showCloseButton={!busy} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle size="compact">
            {translate('browser.clearData.title', 'Clear browsing data')}
          </DialogTitle>
          <DialogDescription size="compact">
            {translate(
              'browser.clearData.scope',
              'Clear saved data for this browser profile, from all time.'
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="divide-y divide-border rounded-md border border-border">
          {[
            {
              checked: cookies,
              set: setCookies,
              label: translate('browser.clearData.cookies', 'Cookies and site data'),
              description: translate(
                'browser.clearData.cookiesDescription',
                'Signs you out of sites in this profile.'
              )
            },
            {
              checked: cache,
              set: setCache,
              label: translate('browser.clearData.cache', 'Cached images and files')
            },
            {
              checked: history,
              set: setHistory,
              label: translate('browser.clearData.history', 'Browsing history')
            }
          ].map((option) => (
            <label key={option.label} className="flex cursor-pointer items-start gap-3 px-3 py-3">
              <Checkbox
                className="mt-0.5"
                checked={option.checked}
                disabled={busy}
                onCheckedChange={(value) => option.set(value === true)}
                aria-label={option.label}
              />
              <span className="space-y-1">
                <span className="block text-sm font-medium">{option.label}</span>
                {option.description && (
                  <span className="block text-xs text-muted-foreground">{option.description}</span>
                )}
              </span>
            </label>
          ))}
        </div>
        {history && (
          <p className="text-xs text-muted-foreground">
            {translate(
              'browser.clearData.legacyHistory',
              'Older history entries are managed separately in History.'
            )}
          </p>
        )}
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {translate(
              'browser.clearData.error',
              'Could not finish clearing data. Reopen this browser page and try again. Some data may already be cleared.'
            )}
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>
            {translate('common.cancel', 'Cancel')}
          </Button>
          <Button
            variant="destructive"
            size="sm"
            className="w-24"
            disabled={busy || (!cookies && !cache && !history)}
            onClick={() => void clear()}
          >
            {busy
              ? translate('browser.clearData.clearing', 'Clearing…')
              : translate('browser.clearData.clear', 'Clear data')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

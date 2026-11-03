import { useEffect, useId, useState } from 'react'
import { getVisibleBrowserClientPagePartition } from '../browser-client-page-renderer-installation'
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
import { Label } from '@/components/ui/label'
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
  const [showClearing, setShowClearing] = useState(false)
  const optionIdPrefix = useId()
  const canClear = !busy && (cookies || cache || history)
  useEffect(() => {
    if (!busy) {
      setShowClearing(false)
      return
    }
    // Fast local clears stay quiet; slower ones get the label swap.
    const timer = setTimeout(() => setShowClearing(true), 200)
    return () => clearTimeout(timer)
  }, [busy])
  const clear = async (): Promise<void> => {
    setBusy(true)
    setError(false)
    try {
      // Client-hosted guests live in the retained page registry, not webviewRegistry.
      const guestPartition =
        webviewRegistry.get(pageId)?.getAttribute('partition') ??
        getVisibleBrowserClientPagePartition(pageId)
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
      <DialogContent size="compact" scrollable showCloseButton={false}>
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
        <div className="space-y-3 text-xs">
          {[
            {
              id: 'cookies',
              checked: cookies,
              set: setCookies,
              label: translate('browser.clearData.cookies', 'Cookies and site data'),
              description: translate(
                'browser.clearData.cookiesDescription',
                'Signs you out of sites in this profile.'
              )
            },
            {
              id: 'cache',
              checked: cache,
              set: setCache,
              label: translate('browser.clearData.cache', 'Cached images and files')
            },
            {
              id: 'history',
              checked: history,
              set: setHistory,
              label: translate('browser.clearData.history', 'Browsing history'),
              description: translate(
                'browser.clearData.legacyHistory',
                'Older entries are managed in History.'
              )
            }
          ].map((option) => {
            const optionId = `${optionIdPrefix}-${option.id}`
            return (
              <div key={option.id} className="flex w-full items-start gap-2">
                <Checkbox
                  id={optionId}
                  checked={option.checked}
                  disabled={busy}
                  onCheckedChange={(value) => option.set(value === true)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && canClear) {
                      void clear()
                    }
                  }}
                  aria-describedby={option.description ? `${optionId}-description` : undefined}
                />
                <span className="min-w-0 flex-1">
                  <Label
                    htmlFor={optionId}
                    className="block cursor-pointer text-xs leading-4 font-medium"
                  >
                    {option.label}
                  </Label>
                  {option.description && (
                    <span
                      id={`${optionId}-description`}
                      className="mt-0.5 block text-muted-foreground"
                    >
                      {option.description}
                    </span>
                  )}
                </span>
              </div>
            )
          })}
        </div>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {translate(
              'browser.clearData.error',
              'Could not finish clearing data. Reopen this browser page and try again. Some data may already be cleared.'
            )}
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" size="sm" className="text-xs" disabled={busy} onClick={onClose}>
            {translate('common.cancel', 'Cancel')}
          </Button>
          <Button
            variant="destructive"
            size="sm"
            className="w-24 text-xs"
            disabled={!canClear}
            onClick={() => void clear()}
          >
            {showClearing
              ? translate('browser.clearData.clearing', 'Clearing…')
              : translate('browser.clearData.clear', 'Clear data')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

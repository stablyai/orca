import { useState } from 'react'
import { webviewRegistry } from '../host-guest/webview-registry'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
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
    <div
      className="scrollbar-sleek max-h-[calc(100vh-16rem)] space-y-3 overflow-y-auto border-b border-border p-4"
      onKeyDown={(event) => event.stopPropagation()}
    >
      <h3 className="text-sm font-medium">
        {translate('browser.clearData.title', 'Clear browsing data')}
      </h3>
      <p className="text-xs text-muted-foreground">
        {translate(
          'browser.clearData.scope',
          'Clear all time for the browser profile used by this page. Cookies and site data are shared by pages in this profile. Clearing them signs you out of sites.'
        )}
      </p>
      {[
        {
          checked: cookies,
          set: setCookies,
          label: translate('browser.clearData.cookies', 'Cookies and site data')
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
        <label key={option.label} className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={option.checked}
            disabled={busy}
            onCheckedChange={(value) => option.set(value === true)}
          />
          {option.label}
        </label>
      ))}
      <p className="text-xs text-muted-foreground">
        {translate(
          'browser.clearData.legacyHistory',
          'History recorded before profile tracking stays in the shared history list. Use Clear browsing history to manage those entries.'
        )}
      </p>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {translate(
            'browser.clearData.error',
            'Could not finish clearing data. Some data may already be cleared. Reopen the browser page and try again. This action requires a local desktop browser guest.'
          )}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>
          {translate('common.cancel', 'Cancel')}
        </Button>
        <Button
          variant="destructive"
          size="sm"
          disabled={busy || (!cookies && !cache && !history)}
          onClick={() => void clear()}
        >
          {busy
            ? translate('browser.clearData.clearing', 'Clearing…')
            : translate('browser.clearData.clear', 'Clear data')}
        </Button>
      </div>
    </div>
  )
}

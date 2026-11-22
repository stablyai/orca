import { useState } from 'react'
import { Star } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { normalizeBrowserBookmarkUrl } from '../../../../../shared/browser/bookmarks/browser-bookmarks'
import { useBrowserBookmarks } from './browser-bookmark-state'

export function BrowserBookmarkStar({ pageId }: { pageId: string }): React.JSX.Element | null {
  const t = useTranslate()
  const { page, scope, key, entries } = useBrowserBookmarks(pageId)
  const [pendingKey, setPendingKey] = useState<string | null>(null)
  const url = page && normalizeBrowserBookmarkUrl(page.url)
  const api = window.api?.browser?.bookmarks
  if (!api || !page || !scope || !entries || !url) {
    return null
  }

  const bookmark = entries.find((entry) => entry.url === url)
  const action = bookmark
    ? t('browser.bookmarks.remove', 'Remove bookmark')
    : t('browser.bookmarks.add', 'Add bookmark')
  const requestKey = JSON.stringify([key, url])
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="muted-field-icon"
          size="icon-xs"
          aria-label={t('browser.bookmarks.toggle', 'Bookmark this page')}
          aria-pressed={Boolean(bookmark)}
          aria-disabled={pendingKey === requestKey}
          onClick={async () => {
            if (pendingKey === requestKey) {
              return
            }
            setPendingKey(requestKey)
            try {
              await api.mutate(
                scope,
                bookmark
                  ? { kind: 'remove', id: bookmark.id }
                  : { kind: 'add', url, title: page.loading ? url : page.title }
              )
            } catch {
              toast.error(t('browser.bookmarks.saveError', 'Could not save bookmark changes'))
            }
            setPendingKey((current) => (current === requestKey ? null : current))
          }}
        >
          <Star className={bookmark ? 'fill-current text-foreground' : undefined} />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {action}
      </TooltipContent>
    </Tooltip>
  )
}

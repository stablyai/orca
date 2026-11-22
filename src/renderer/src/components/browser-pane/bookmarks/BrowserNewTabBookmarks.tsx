import { Globe, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { BrowserNewTabRow } from '../new-tab/browser-new-tab-row'
import { BrowserBookmarkEdit } from './BrowserBookmarkEdit'
import { useBrowserBookmarks } from './browser-bookmark-state'

export function BrowserNewTabBookmarks({
  pageId,
  onOpenUrl
}: {
  pageId: string
  onOpenUrl: (url: string) => void
}): React.JSX.Element | null {
  const t = useTranslate()
  const { scope, key, entries, failed } = useBrowserBookmarks(pageId)
  const api = window.api?.browser?.bookmarks
  if (!api || !scope) {
    return null
  }
  if (failed) {
    return (
      <p role="status" className="px-2 text-sm text-muted-foreground">
        {t('browser.bookmarks.loadError', 'Could not load bookmarks')}
      </p>
    )
  }
  if (!entries) {
    return null
  }
  if (entries.length === 0) {
    return (
      <p className="px-2 text-sm text-muted-foreground">
        {t('browser.bookmarks.empty', 'Use the star beside a page’s address to bookmark it.')}
      </p>
    )
  }
  const removeLabel = t('browser.bookmarks.remove', 'Remove bookmark')
  return (
    <ul className="min-w-0">
      {entries.map((bookmark) => (
        <li key={`${key}:${bookmark.id}`} className="flex min-w-0 items-center">
          <BrowserNewTabRow
            icon={<Globe className="size-4 text-muted-foreground" />}
            title={bookmark.title || bookmark.url}
            detail={<span title={bookmark.url}>{bookmark.url}</span>}
            onOpen={() => onOpenUrl(bookmark.url)}
          />
          <BrowserBookmarkEdit bookmark={bookmark} scope={scope} />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={t('browser.bookmarks.removeNamed', 'Remove bookmark for {{title}}', {
                  title: bookmark.title || bookmark.url
                })}
                onClick={() => {
                  void api.mutate(scope, { kind: 'remove', id: bookmark.id }).catch(() => {
                    toast.error(t('browser.bookmarks.saveError', 'Could not save bookmark changes'))
                  })
                }}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              {removeLabel}
            </TooltipContent>
          </Tooltip>
        </li>
      ))}
    </ul>
  )
}

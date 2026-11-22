import { useId, useState } from 'react'
import { Pencil } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import {
  normalizeBrowserBookmarkUrl,
  type BrowserBookmark,
  type BrowserBookmarkScope
} from '../../../../../shared/browser/bookmarks/browser-bookmarks'

export function BrowserBookmarkEdit({
  bookmark,
  scope
}: {
  bookmark: BrowserBookmark
  scope: BrowserBookmarkScope
}): React.JSX.Element {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const label = t('browser.bookmarks.edit', 'Edit bookmark')
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button type="button" variant="ghost" size="icon-xs" aria-label={label}>
              <Pencil className="size-3.5" />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {label}
        </TooltipContent>
      </Tooltip>
      <PopoverContent
        align="end"
        aria-label={label}
        className="w-72 max-w-[var(--radix-popover-content-available-width)]"
      >
        {open ? (
          <BrowserBookmarkForm bookmark={bookmark} scope={scope} onClose={() => setOpen(false)} />
        ) : null}
      </PopoverContent>
    </Popover>
  )
}

function BrowserBookmarkForm({
  bookmark,
  scope,
  onClose
}: {
  bookmark: BrowserBookmark
  scope: BrowserBookmarkScope
  onClose: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const [title, setTitle] = useState(bookmark.title)
  const [address, setAddress] = useState(bookmark.url)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<'invalid' | 'duplicate' | 'save' | null>(null)
  const errorId = useId()
  const errorMessage = {
    invalid: t('browser.bookmarks.invalidAddress', 'Enter a valid HTTP or HTTPS address'),
    duplicate: t('browser.bookmarks.duplicate', 'This address is already bookmarked'),
    save: t('browser.bookmarks.saveError', 'Could not save bookmark changes')
  }
  const addressInvalid = error === 'invalid' || error === 'duplicate'

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={async (event) => {
        event.preventDefault()
        const api = window.api.browser.bookmarks
        if (pending || !api) {
          return
        }
        const url = normalizeBrowserBookmarkUrl(address)
        if (!url) {
          setError('invalid')
          return
        }
        setPending(true)
        setError(null)
        try {
          const result = await api.mutate(scope, { kind: 'edit', id: bookmark.id, title, url })
          if (result === 'saved') {
            onClose()
          } else {
            setError(result === 'duplicate' ? 'duplicate' : 'save')
          }
        } catch {
          setError('save')
        }
        setPending(false)
      }}
    >
      <label className="flex flex-col gap-1 text-xs font-medium">
        {t('browser.bookmarks.title', 'Title')}
        <Input density="compact" value={title} onChange={(event) => setTitle(event.target.value)} />
      </label>
      <label className="flex flex-col gap-1 text-xs font-medium">
        {t('browser.bookmarks.address', 'Address')}
        <Input
          density="compact"
          value={address}
          spellCheck={false}
          autoCapitalize="none"
          aria-invalid={addressInvalid}
          aria-describedby={addressInvalid ? errorId : undefined}
          onChange={(event) => {
            setAddress(event.target.value)
            setError(null)
          }}
        />
      </label>
      {error ? (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          {errorMessage[error]}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onClose}>
          {t('common.cancel', 'Cancel')}
        </Button>
        <Button type="submit" size="sm" disabled={pending}>
          {t('browser.bookmarks.save', 'Save')}
        </Button>
      </div>
    </form>
  )
}

import type { RefObject } from 'react'
import { ImageIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { isScreenSubmitShortcut } from '@/lib/keyboard/screen-submit-shortcut'
import { useTranslate } from '@/i18n/use-translate'
import { hasBoundedGitHubMarkdownImageUrlText } from './github-markdown-image-url'

export function GitHubMarkdownImageInput({
  imageUrl,
  imageInputRef,
  setImageUrl,
  setImageInputOpen,
  insertImageUrl,
  disabled
}: {
  imageUrl: string
  imageInputRef: RefObject<HTMLInputElement | null>
  setImageUrl: (value: string) => void
  setImageInputOpen: (open: boolean) => void
  insertImageUrl: () => void
  disabled: boolean
}) {
  const t = useTranslate()
  return (
    <form
      className="github-markdown-composer-image-row"
      onSubmit={(event) => {
        event.preventDefault()
        insertImageUrl()
      }}
    >
      <ImageIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <Input
        ref={imageInputRef}
        value={imageUrl}
        onChange={(event) => setImageUrl(event.target.value)}
        onKeyDown={(event) => {
          if (isScreenSubmitShortcut(event)) {
            event.preventDefault()
            event.stopPropagation()
            insertImageUrl()
            return
          }
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            setImageInputOpen(false)
          }
        }}
        placeholder={t('auto.components.github.GitHubMarkdownComposer.f24783f470', 'https://...')}
        disabled={disabled}
        className="h-8 min-w-0 text-xs"
      />
      <Button
        type="submit"
        size="xs"
        disabled={disabled || !hasBoundedGitHubMarkdownImageUrlText(imageUrl)}
      >
        {t('auto.components.github.GitHubMarkdownComposer.e3bd59143c', 'Insert')}
      </Button>
      <Button type="button" variant="ghost" size="xs" onClick={() => setImageInputOpen(false)}>
        {t('auto.components.github.GitHubMarkdownComposer.015b4e607d', 'Cancel')}
      </Button>
    </form>
  )
}

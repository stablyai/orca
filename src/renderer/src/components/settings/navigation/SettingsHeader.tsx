import type { ReactNode } from 'react'
import { X } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { BreadcrumbButton } from '../../ui/breadcrumb-button'
import { Button } from '../../ui/button'

type SettingsHeaderProps = {
  title: string
  subPageTitle?: string
  hostPicker?: ReactNode
  /** The middle crumb: back from a sub-page to its section. */
  onParent: () => void
  onClose: () => void
}

export function SettingsHeader({
  title,
  subPageTitle,
  hostPicker,
  onParent,
  onClose
}: SettingsHeaderProps): React.JSX.Element {
  const t = useTranslate()
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-5 text-sm">
      <nav
        aria-label={t('settings.breadcrumb.label', 'Settings breadcrumb')}
        className="flex min-w-0 items-center gap-2"
      >
        <span className="text-muted-foreground">
          {t('settings.breadcrumb.settings', 'Settings')}
        </span>
        <span aria-hidden="true" className="text-muted-foreground">
          /
        </span>
        {subPageTitle ? (
          <>
            <BreadcrumbButton onClick={onParent}>{title}</BreadcrumbButton>
            <span aria-hidden="true" className="text-muted-foreground">
              /
            </span>
            <span aria-current="page" className="truncate">
              {subPageTitle}
            </span>
          </>
        ) : (
          <span aria-current="page" className="truncate">
            {title}
          </span>
        )}
      </nav>
      <div className="ml-auto min-w-0">{hostPicker}</div>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={onClose}
        aria-label={t('settings.breadcrumb.close', 'Close settings')}
      >
        <X className="size-4" />
      </Button>
    </header>
  )
}

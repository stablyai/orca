import { Info } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { DropdownMenuLabel, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'

export function BrowserCookieImportDisclosure(): React.JSX.Element {
  const t = useTranslate()
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuLabel className="flex max-w-64 items-start gap-2 whitespace-normal py-2 font-normal">
        <Info aria-hidden className="mt-0.5 size-3.5 shrink-0" />
        <span className="min-w-0">
          <span className="block font-medium leading-4 text-foreground">
            {t(
              'auto.components.BrowserCookieImportDisclosure.title',
              "Google logins aren't imported"
            )}
          </span>
          <span className="block leading-4 text-muted-foreground">
            {t(
              'auto.components.BrowserCookieImportDisclosure.description',
              'Sign in to Google directly in Orca.'
            )}
          </span>
        </span>
      </DropdownMenuLabel>
    </>
  )
}

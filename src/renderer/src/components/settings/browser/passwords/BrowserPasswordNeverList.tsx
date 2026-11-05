import { ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { translate } from '@/i18n/i18n'
import { browserPasswordHostOf } from './browser-password-import-toast'

/** Sites the user told the save offer to skip; removing one lets Orca offer again there. */
export function BrowserPasswordNeverList({
  origins,
  onRemove
}: {
  origins: string[]
  onRemove: (origin: string) => void
}): React.JSX.Element | null {
  if (origins.length === 0) {
    return null
  }
  return (
    <Collapsible>
      <CollapsibleTrigger asChild>
        <Button type="button" variant="ghost" size="xs">
          <ChevronRight className="transition-transform in-data-[state=open]:rotate-90" />
          {translate('settings.browser.passwords.neverHeading', 'Never saved for {{count}} sites', {
            count: origins.length
          })}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1 divide-y divide-border/50">
          {origins.map((origin) => (
            <div key={origin} className="flex items-center gap-3 py-1.5 pl-5">
              <div className="min-w-0 flex-1 truncate text-xs">{browserPasswordHostOf(origin)}</div>
              <Button type="button" variant="ghost" size="xs" onClick={() => onRemove(origin)}>
                {translate('settings.browser.passwords.removeNever', 'Remove')}
              </Button>
            </div>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

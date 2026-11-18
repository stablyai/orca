import { Button } from '../ui/button'
import { useTranslate } from '@/i18n/use-translate'
import {
  openAppHttpLink,
  openAppHttpLinkFromAnchor
} from '@/lib/browser/navigation/app-http-link-open'

/** Unsigned macOS builds cannot self-update (docs/zotz/UPDATES-SPEC.md §6): offer the dmg instead. */
export function ZotzMacManualUpdateNote({ url }: { url: string }): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs leading-relaxed text-muted-foreground">
        {t(
          'zotz.updater.macManualNote',
          'On macOS Zotz cannot install updates itself yet. Download the new version, quit Zotz and drag it into Applications to replace it. Open it the first time with right-click → Open.'
        )}
      </p>
      <Button
        variant="default"
        size="sm"
        className="w-full cursor-pointer"
        onClick={(event) => openAppHttpLink(url, { event })}
      >
        {t('zotz.updater.macManualDownload', 'Download the new version')}
      </Button>
    </div>
  )
}

/** Settings → About status line on macOS. */
export function ZotzMacManualUpdateLink({ url }: { url: string }): React.JSX.Element {
  const t = useTranslate()
  return (
    <>
      {t(
        'zotz.updater.macManualStatus',
        'is available. On macOS, download it and replace Zotz in Applications.'
      )}{' '}
      <a
        href={url}
        target="_blank"
        onClick={openAppHttpLinkFromAnchor}
        rel="noopener noreferrer"
        className="underline hover:text-foreground"
      >
        {t('zotz.updater.macManualDownload', 'Download the new version')}
      </a>
    </>
  )
}

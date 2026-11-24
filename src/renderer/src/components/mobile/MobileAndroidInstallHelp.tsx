import { ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'

type MobileAndroidInstallHelpProps = {
  onOpenGuide: () => void
}

export function MobileAndroidInstallHelp({
  onOpenGuide
}: MobileAndroidInstallHelpProps): React.JSX.Element {
  const t = useTranslate()
  return (
    <Button
      type="button"
      variant="link"
      size="xs"
      className="mt-2 h-6 px-0 text-xs text-muted-foreground hover:text-foreground"
      onClick={onOpenGuide}
    >
      {t('auto.components.mobile.MobileHero.androidHelp.guide', 'Install guide')}
      <ExternalLink className="size-3" />
    </Button>
  )
}

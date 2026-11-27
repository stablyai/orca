import { useState } from 'react'
import { BookOpen, ChevronDown, CircleUserRound, Files, Smartphone, X } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { Button } from '../ui/button'
import { Card } from '../ui/card'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible'
import { OrcaSignInButton, OrcaSignInWaitNotice } from '../orca-profiles/OrcaSignInProgress'

function FeatureRow({
  icon: Icon,
  title,
  description
}: {
  icon: typeof Files
  title: string
  description: string
}): React.JSX.Element {
  return (
    <div className="flex items-start gap-2.5">
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="space-y-0.5">
        <p className="text-xs font-medium">{title}</p>
        <p className="text-xs leading-5 text-muted-foreground">{description}</p>
      </div>
    </div>
  )
}

export function UnexpectedSignoutCardBody({
  email,
  canConnect,
  onDismiss
}: {
  email: string | null
  canConnect: boolean
  onDismiss: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const [expanded, setExpanded] = useState(false)

  return (
    <div>
      <Card
        className="py-0 gap-0 shadow-floating"
        role="complementary"
        aria-live="polite"
        aria-labelledby="unexpected-signout-heading"
      >
        <div className="flex flex-col gap-2.5 p-3.5">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2">
              <CircleUserRound className="size-4 text-muted-foreground" />
              <h3 id="unexpected-signout-heading" className="text-sm font-semibold">
                {t('auto.components.UnexpectedSignoutCard.9f2c1a4b7d', "You've been signed out")}
              </h3>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 shrink-0"
              onClick={onDismiss}
              aria-label={t('auto.components.UnexpectedSignoutCard.3e8f5c2a91', 'Dismiss')}
            >
              <X className="size-3.5" />
            </Button>
          </div>

          <p className="text-sm text-muted-foreground">
            {email
              ? t(
                  'auto.components.UnexpectedSignoutCard.7b4d9e1f2a',
                  'Sign in again as {{value0}} to restore Artifact sharing, Orca Relay, and skill sharing.',
                  { value0: email }
                )
              : t(
                  'auto.components.UnexpectedSignoutCard.5a1c8d3e6f',
                  'Sign in again to restore Artifact sharing, Orca Relay, and skill sharing.'
                )}
          </p>

          <Collapsible open={expanded} onOpenChange={setExpanded}>
            <CollapsibleTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="w-fit gap-1 px-1 text-xs text-muted-foreground"
                aria-expanded={expanded}
              >
                {t('auto.components.UnexpectedSignoutCard.1f6b2c9d4e', 'What you get back')}
                <ChevronDown
                  className={cn('size-3.5 transition-transform', expanded && 'rotate-180')}
                />
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-3 pt-2.5">
              <FeatureRow
                icon={Files}
                title={t('auto.components.UnexpectedSignoutCard.8d2e4f7a1b', 'Artifact sharing')}
                description={t(
                  'auto.components.UnexpectedSignoutCard.2c9a5b6e8d',
                  'Publish HTML and Markdown files and manage every shared link from Orca.'
                )}
              />
              <FeatureRow
                icon={Smartphone}
                title={t('auto.components.UnexpectedSignoutCard.6e3f1a9c5b', 'Orca Relay')}
                description={t(
                  'auto.components.UnexpectedSignoutCard.4b7d2e8f1a',
                  'Connect Orca Mobile to this desktop across cellular or any Wi-Fi.'
                )}
              />
              <FeatureRow
                icon={BookOpen}
                title={t('auto.components.UnexpectedSignoutCard.9a4c6b2d7e', 'Skill sharing')}
                description={t(
                  'auto.components.UnexpectedSignoutCard.3d8e5f1b9c',
                  'Share skills behind an unlisted link and install them on any machine you use.'
                )}
              />
            </CollapsibleContent>
          </Collapsible>

          <div className="mt-0.5 flex gap-2">
            <OrcaSignInButton variant="default" size="sm" className="flex-1" disabled={!canConnect}>
              {t('auto.components.UnexpectedSignoutCard.c5b3e8a17d', 'Sign in to Orca')}
            </OrcaSignInButton>
          </div>
          <OrcaSignInWaitNotice />
        </div>
      </Card>
    </div>
  )
}

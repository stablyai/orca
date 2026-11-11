import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import { isLongSkillDescription } from './skill-description-length'

/** Descriptions include long trigger documentation; disclose the rest after the opening lines. */
export function SkillDescriptionDisclosure({
  description,
  className
}: {
  description: string | null | undefined
  className?: string
}): React.JSX.Element | null {
  const t = useTranslate()
  const [expanded, setExpanded] = useState(false)
  if (!description) {
    return null
  }
  const long = isLongSkillDescription(description)
  return (
    <div className={cn('space-y-0.5', className)}>
      <p
        className={cn(
          'break-words text-xs leading-5 text-muted-foreground',
          long && !expanded && 'line-clamp-2'
        )}
      >
        {description}
      </p>
      {long ? (
        <Button
          type="button"
          variant="link"
          className="h-auto p-0 text-xs font-normal text-muted-foreground no-underline hover:text-foreground hover:no-underline"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded
            ? t('auto.components.skills.description.showLess', 'Show less')
            : t('auto.components.skills.description.showMore', 'Show more')}
        </Button>
      ) : null}
    </div>
  )
}

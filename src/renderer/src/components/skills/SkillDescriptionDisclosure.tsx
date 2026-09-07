import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { isLongSkillDescription } from './skill-description-length'

/**
 * A skill description doubles as its trigger documentation, so it can run for
 * paragraphs. Show the opening lines and let the reader ask for the rest.
 */
export function SkillDescriptionDisclosure({
  description,
  className
}: {
  description: string | null | undefined
  className?: string
}): React.JSX.Element | null {
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
            ? translate('auto.components.skills.description.showLess', 'Show less')
            : translate('auto.components.skills.description.showMore', 'Show more')}
        </Button>
      ) : null}
    </div>
  )
}

import { ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CollapsibleTrigger } from '@/components/ui/collapsible'

/** Radix stamps `data-state` on the trigger, so the chevron follows the section
 *  without a second copy of its open state in React. */
export function SkillDisclosureTrigger({ label }: { label: string }): React.JSX.Element {
  return (
    <CollapsibleTrigger asChild>
      <Button
        type="button"
        variant="link"
        // Why: the button size variant adds `has-[>svg]:px-3`, which a plain
        // `p-0` cannot override — the chevron would sit indented from the label
        // it belongs to.
        className="group h-auto gap-1 p-0 text-xs font-normal text-muted-foreground no-underline hover:text-foreground hover:no-underline has-[>svg]:px-0"
      >
        <ChevronRight className="size-3 transition-transform group-data-[state=open]:rotate-90" />
        {label}
      </Button>
    </CollapsibleTrigger>
  )
}

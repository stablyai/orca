import { ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CollapsibleTrigger } from '@/components/ui/collapsible'

/** Follow Radix’s data-state for chevron rotation without duplicating open state. */
export function SkillDisclosureTrigger({ label }: { label: string }): React.JSX.Element {
  return (
    <CollapsibleTrigger asChild>
      <Button
        type="button"
        variant="link"
        // Override the size variant’s has-[>svg]:px-3; plain p-0 cannot remove the chevron indentation.
        className="group h-auto gap-1 p-0 text-xs font-normal text-muted-foreground no-underline hover:text-foreground hover:no-underline has-[>svg]:px-0"
      >
        <ChevronRight className="size-3 transition-transform group-data-[state=open]:rotate-90" />
        {label}
      </Button>
    </CollapsibleTrigger>
  )
}

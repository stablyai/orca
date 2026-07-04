import { ChevronDown } from 'lucide-react'
import { Button } from '../ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible'
import { cn } from '@/lib/utils'

type SshTargetFormCollapsibleSectionProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  children: React.ReactNode
}

export function SshTargetFormCollapsibleSection({
  open,
  onOpenChange,
  title,
  description,
  children
}: SshTargetFormCollapsibleSectionProps): React.JSX.Element {
  return (
    <Collapsible
      open={open}
      onOpenChange={onOpenChange}
      className="col-span-2 border-t border-border/50 pt-2"
    >
      <CollapsibleTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="-ml-2 h-auto w-[calc(100%+0.5rem)] justify-between gap-3 px-2 py-1.5 text-left"
        >
          <span className="min-w-0 space-y-0.5">
            <span className="block text-sm font-medium text-foreground">{title}</span>
            <span className="block text-[11px] font-normal text-muted-foreground">
              {description}
            </span>
          </span>
          <ChevronDown
            className={cn('size-4 shrink-0 transition-transform', open && 'rotate-180')}
          />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="collapsible-height-content">
        <div className="space-y-4 pt-3">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  )
}

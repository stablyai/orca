import { ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/class-names'

export function BotSidebarComputerHeader({
  name,
  folded,
  onToggle
}: {
  name: string
  folded: boolean
  onToggle: () => void
}): React.JSX.Element {
  return (
    <Button
      type="button"
      variant="disclosure"
      size="sm"
      className="w-full justify-start"
      aria-expanded={!folded}
      onClick={onToggle}
    >
      <ChevronDown aria-hidden="true" className={cn('size-3.5', folded && '-rotate-90')} />
      <span className="truncate">{name}</span>
    </Button>
  )
}

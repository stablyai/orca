import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'

export function TerminalRichInputChipRemoveButton({
  label,
  onRemove
}: {
  label: string
  onRemove: () => void
}): React.JSX.Element {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      onMouseDown={(event) => {
        event.preventDefault()
        event.stopPropagation()
      }}
      onClick={(event) => {
        event.stopPropagation()
        onRemove()
      }}
      aria-label={label}
      className="size-5 rounded-sm text-muted-foreground can-hover:pointer-events-none can-hover:absolute can-hover:left-0.5 can-hover:top-0.5 can-hover:opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 hover:text-accent-foreground"
    >
      <X className="size-3" />
    </Button>
  )
}

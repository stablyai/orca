import { FilePenLine } from 'lucide-react'
import { Button } from '@/components/ui/button'

export function TerminalDraftTrigger({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30 flex justify-start p-3">
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="pointer-events-auto"
        onClick={onOpen}
        onMouseDown={(event) => event.stopPropagation()}
        aria-label="Open terminal draft editor"
      >
        <FilePenLine className="size-3.5" />
        Draft
      </Button>
    </div>
  )
}

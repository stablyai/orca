import { SquareTerminal } from 'lucide-react'
import { Button } from '@/components/ui/button'

export function DeferredActivationTerminal({
  onStart
}: {
  onStart: () => void
}): React.JSX.Element {
  return (
    <div className="flex h-full w-full items-center justify-center bg-background">
      <Button type="button" size="sm" variant="outline" onClick={onStart}>
        <SquareTerminal className="size-4" />
        Start Terminal
      </Button>
    </div>
  )
}

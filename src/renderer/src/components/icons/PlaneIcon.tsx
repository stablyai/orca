import { SquareKanban } from 'lucide-react'

export function PlaneIcon({ className }: { className?: string }): React.JSX.Element {
  return <SquareKanban aria-hidden className={className} />
}

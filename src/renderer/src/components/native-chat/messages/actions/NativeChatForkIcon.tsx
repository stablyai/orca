import { Split } from 'lucide-react'
import { cn } from '@/lib/utils'

/** Fork: a path splitting in two, pointing forward like the chat it branches. */
export function NativeChatForkIcon({ className }: { className?: string }): React.JSX.Element {
  return <Split className={cn('size-3.5 rotate-90', className)} aria-hidden />
}

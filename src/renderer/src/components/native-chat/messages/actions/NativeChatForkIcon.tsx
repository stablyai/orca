import { Split } from 'lucide-react'

/** Fork: a path splitting in two, pointing forward like the chat it branches. */
export function NativeChatForkIcon({ className }: { className?: string }): React.JSX.Element {
  return <Split className={`size-3.5 rotate-90${className ? ` ${className}` : ''}`} aria-hidden />
}

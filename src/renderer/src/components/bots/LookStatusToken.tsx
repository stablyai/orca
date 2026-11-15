// One status word beside a look's line: "Needs you" when the owner should step in, else a neutral note.
// TODO: switch to the bot-run-failure severity tokens once that design lands on main.
import { CircleAlert, Info } from 'lucide-react'
import { cn } from '@/lib/class-names'

export function LookStatusToken({
  severity,
  children,
  className
}: {
  severity: 'need' | 'info'
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  const Icon = severity === 'need' ? CircleAlert : Info
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-px text-[11px] font-medium leading-4 whitespace-nowrap',
        severity === 'need'
          ? 'bg-destructive/10 text-destructive'
          : 'bg-muted text-muted-foreground',
        className
      )}
    >
      <Icon className="size-3" aria-hidden />
      {children}
    </span>
  )
}

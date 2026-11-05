import { cn } from '@/lib/utils'

/** Reject writes while busy without disabling the focused control; delay dimming so quick writes do not flash. */
export function NativeChatSessionOptionWriteGroup(props: {
  busy: boolean
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      role="group"
      aria-disabled={props.busy}
      data-busy={props.busy}
      className={cn(
        'transition-opacity duration-150 motion-reduce:duration-0 data-[busy=true]:pointer-events-none data-[busy=true]:opacity-50 data-[busy=true]:delay-200',
        props.className
      )}
    >
      {props.children}
    </div>
  )
}

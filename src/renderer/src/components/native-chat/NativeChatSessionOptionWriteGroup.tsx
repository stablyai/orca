import { cn } from '@/lib/utils'

/** Controls that write to the session. While their write is in flight they take nothing and say
 *  so, without `disabled`: that would drop keyboard focus from the control just used. The dimming
 *  waits out a local write, so only a slow one is seen waiting (STYLEGUIDE, in-flight feedback). */
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

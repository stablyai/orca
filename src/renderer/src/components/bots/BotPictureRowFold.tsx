import React from 'react'
import { cn } from '@/lib/class-names'

/**
 * A row under the picture carousel that folds its height to zero and fades out when closed.
 * Two folds side by side cross-fade: one shrinks while the other grows, so the total height
 * moves smoothly from one row to the other, at the carousel's own 300 ms.
 */
export function BotPictureRowFold({
  open,
  className,
  children
}: {
  open: boolean
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      aria-hidden={!open}
      inert={!open}
      className={cn(
        'grid transition-[grid-template-rows,opacity] duration-300 ease-out motion-reduce:transition-none',
        open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
      )}
    >
      {/* Padding lives inside the clipped box, or a closed row would keep it as height; the clip
          margin leaves room for selection and focus rings. */}
      <div className="min-h-0 overflow-clip [overflow-clip-margin:6px]">
        {className ? <div className={className}>{children}</div> : children}
      </div>
    </div>
  )
}

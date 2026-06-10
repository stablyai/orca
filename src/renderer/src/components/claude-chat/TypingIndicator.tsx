import React from 'react'

// Why: iMessage-style staggered dot animation using Tailwind's built-in
// animate-bounce with arbitrary animation-delay values for the stagger effect.
export function TypingIndicator(): React.JSX.Element {
  return (
    <div className="flex items-end gap-1.5">
      <div className="flex items-center gap-1 rounded-2xl rounded-bl-sm bg-muted px-3 py-2">
        <span
          className="inline-block size-1.5 rounded-full bg-muted-foreground/60 animate-bounce [animation-delay:0ms]"
          aria-hidden="true"
        />
        <span
          className="inline-block size-1.5 rounded-full bg-muted-foreground/60 animate-bounce [animation-delay:150ms]"
          aria-hidden="true"
        />
        <span
          className="inline-block size-1.5 rounded-full bg-muted-foreground/60 animate-bounce [animation-delay:300ms]"
          aria-hidden="true"
        />
      </div>
      <span className="sr-only">Claude is typing…</span>
    </div>
  )
}

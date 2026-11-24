import { cn } from '@/lib/class-names'

/** A person with no Slack photo: a grey square with a white head and shoulders, as chat apps draw it. */
export function SlackPersonPlaceholder({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 32 32"
      aria-hidden
      className={cn('block size-full bg-[#c9cacc] text-white dark:bg-[#5b5d61]', className)}
    >
      <circle cx="16" cy="12.5" r="5.5" fill="currentColor" />
      <path d="M5 32c0-7 4.9-11.5 11-11.5S27 25 27 32z" fill="currentColor" />
    </svg>
  )
}

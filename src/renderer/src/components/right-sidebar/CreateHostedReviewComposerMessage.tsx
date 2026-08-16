import { TriangleAlert } from 'lucide-react'

/** Inline blocking message for the create-review composer. */
export function CreateHostedReviewComposerMessage({
  children
}: {
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <p className="flex items-start gap-1 text-[11px] text-destructive">
      <TriangleAlert className="mt-px size-3 shrink-0" aria-hidden="true" />
      <span>{children}</span>
    </p>
  )
}

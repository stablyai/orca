import { cn } from '@/lib/utils'

// The translucent surface and stronger border/shadow keep dialogs distinct from
// the same-color dark canvas, matching the established dropdown treatment.
const DIALOG_CONTENT_BASE_CLASS =
  'fixed top-[50%] left-[50%] z-50 grid w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 rounded-lg border border-black/14 bg-background/96 p-6 text-foreground shadow-[0_20px_60px_rgba(0,0,0,0.28),inset_0_1px_0_rgba(255,255,255,0.08)] backdrop-blur-2xl duration-200 outline-none dark:border-white/14 dark:bg-[rgba(23,23,23,0.96)] dark:shadow-[0_24px_72px_rgba(0,0,0,0.55),inset_0_1px_0_rgba(255,255,255,0.06)] data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95'

const DIALOG_CONTENT_DEFAULT_MAX_WIDTH = 'sm:max-w-lg'

const CALLER_UNSCOPED_MAX_WIDTH = /(?:^|\s)!?max-w-/

// Bare widths must replace the responsive default across breakpoints; scoped
// widths keep the default outside their own responsive or selector scope.
export function resolveDialogContentClassName(className?: string): string {
  const hasUnscopedCallerMaxWidth = className ? CALLER_UNSCOPED_MAX_WIDTH.test(className) : false
  return cn(
    DIALOG_CONTENT_BASE_CLASS,
    !hasUnscopedCallerMaxWidth && DIALOG_CONTENT_DEFAULT_MAX_WIDTH,
    className
  )
}

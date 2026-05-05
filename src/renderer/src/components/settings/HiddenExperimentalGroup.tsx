import { Label } from '../ui/label'

// Why: anything in this group is deliberately unfinished or staff-only. The
// orange treatment (header tint, label colors) is the shared visual signal
// for hidden-experimental items so future entries inherit the same
// affordance without another round of styling decisions.
export function HiddenExperimentalGroup(): React.JSX.Element {
  return (
    <section className="space-y-3 rounded-lg border border-orange-500/40 bg-orange-500/5 p-3">
      <div className="space-y-0.5">
        <h4 className="text-sm font-semibold text-orange-500 dark:text-orange-300">
          Hidden experimental
        </h4>
        <p className="text-xs text-orange-500/80 dark:text-orange-300/80">
          Unlisted toggles for internal testing. Nothing here is supported.
        </p>
      </div>

      <div className="flex items-start justify-between gap-4 rounded-md border border-orange-500/30 bg-orange-500/10 px-3 py-2.5">
        <div className="min-w-0 shrink space-y-0.5">
          <Label className="text-orange-600 dark:text-orange-300">Placeholder toggle</Label>
          <p className="text-xs text-orange-600/80 dark:text-orange-300/80">
            Does nothing today. Reserved as the first slot for hidden experimental options.
          </p>
        </div>
        <button
          type="button"
          aria-label="Placeholder toggle"
          className="relative inline-flex h-5 w-9 shrink-0 cursor-not-allowed items-center rounded-full border border-orange-500/40 bg-orange-500/20 opacity-70"
          disabled
        >
          <span className="inline-block h-3.5 w-3.5 translate-x-0.5 transform rounded-full bg-orange-200 shadow-sm dark:bg-orange-100" />
        </button>
      </div>
    </section>
  )
}

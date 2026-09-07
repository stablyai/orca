// Why: no padding here — a field that adds `pr-*` for a trailing icon would tie with
// `px-*` on specificity and lose, so each field sets its own. Why `md:text-xs`: the
// Input primitive steps up to 14px at md, too loud for a sidebar full of branch refs.
export const COMPOSER_FIELD_CLASS = 'h-8 text-xs md:text-xs'

// Why: mirrors the Input primitive's skin so the description can't drift from the
// title and base fields it sits between; there is no Textarea primitive to extend.
export const COMPOSER_TEXTAREA_CLASS =
  'w-full min-w-0 appearance-none rounded-md border border-input bg-transparent px-2 py-1.5 text-xs shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30'

// Why: the Checkbox primitive's default hairline is tuned for card/popover surfaces;
// on the sidebar it needs the same border token the fields use to stay visible.
export const COMPOSER_CHECKBOX_CLASS = 'shrink-0 border-input'

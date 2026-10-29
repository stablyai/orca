// Leave padding to fields with trailing icons; md:text-xs overrides the Input primitive's louder 14px breakpoint.
export const COMPOSER_FIELD_CLASS = 'h-8 text-xs md:text-xs'

// Mirror Input styling so the description matches title/base; no Textarea primitive exists to extend.
export const COMPOSER_TEXTAREA_CLASS =
  'w-full min-w-0 appearance-none rounded-md border border-input bg-transparent px-2 py-1.5 text-xs shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30'

// Use field border tokens because Checkbox's default hairline disappears on sidebar surfaces.
export const COMPOSER_CHECKBOX_CLASS = 'shrink-0 border-input'

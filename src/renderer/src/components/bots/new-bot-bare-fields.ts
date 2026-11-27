// New bot's borderless fields. The caret is their focus sign; while Tab moves focus the dialog is
// marked, and they also get a faint outline that a click or the opening focus would not.

const ATTR = 'data-keyboard-nav'

/** A field's reason it blocks Create, under it in red: the name's and the identity's alike. */
export const FIELD_ERROR = 'mt-1 text-xs text-destructive'

/** Spread onto the DialogContent that holds the fields. */
export const keyboardNavMarkerHandlers = {
  onKeyDown: (event: React.KeyboardEvent<HTMLElement>): void => {
    if (event.key === 'Tab') {
      event.currentTarget.setAttribute(ATTR, '')
    }
  },
  onPointerDown: (event: React.PointerEvent<HTMLElement>): void => {
    event.currentTarget.removeAttribute(ATTR)
  }
}

const BARE =
  'w-full min-w-0 resize-none border-0 bg-transparent outline-none placeholder:text-muted-foreground in-data-keyboard-nav:focus-visible:outline-1 in-data-keyboard-nav:focus-visible:outline-ring/60 in-data-keyboard-nav:focus-visible:outline-solid'

/** The name, beside the picture: large and left-aligned; a long one truncates. */
export const BARE_HEADING_CLASS = `${BARE} truncate rounded-sm p-0 text-xl leading-[26px] font-semibold tracking-[-0.018em]`

/** A template's Watches / Does / Reports line. */
export const BARE_LINE_CLASS = `${BARE} block rounded-sm p-0 text-sm leading-5 [field-sizing:content]`

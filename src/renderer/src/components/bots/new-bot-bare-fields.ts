// New bot's borderless fields. The caret is their focus sign; while Tab moves focus the dialog is
// marked, and they also get a faint outline that a click or the opening focus would not.

const ATTR = 'data-keyboard-nav'

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

/** The name: large, centered. */
export const BARE_HEADING_CLASS = `${BARE} rounded-md px-9 py-1 text-center text-2xl font-semibold placeholder:font-medium`

/** The purpose under the name: centered and muted; three lines, then it scrolls. */
export const BARE_CAPTION_CLASS = `${BARE} block max-h-[calc(3lh+0.25rem)] rounded-md px-9 py-0.5 text-center text-sm leading-5 text-muted-foreground [field-sizing:content] placeholder:text-muted-foreground/70`

/** A template's Watches / Does / Reports line. */
export const BARE_LINE_CLASS = `${BARE} block rounded-sm p-0 text-sm leading-5 [field-sizing:content]`

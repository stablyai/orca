export const REPO_HEADER_ACTION_REVEAL_CLASS =
  'min-w-0 max-w-0 -ml-1.5 overflow-hidden opacity-0 focus:ml-0 focus:max-w-5 focus:opacity-100 group-hover:ml-0 group-hover:max-w-5 group-hover:opacity-100'

// Why: an empty project (e.g. a freshly added bare repo) renders nothing under
// its header, so the create button is its only affordance — keep it visible
// instead of hover-revealed. Merged over the reveal class via cn/tailwind-merge.
export const REPO_HEADER_ACTION_ALWAYS_VISIBLE_CLASS = 'ml-0 max-w-5 opacity-100'

export const REPO_HEADER_ACTION_BUTTON_CLASS = `size-5 shrink-0 ${REPO_HEADER_ACTION_REVEAL_CLASS} rounded-md text-muted-foreground transition-[margin,max-width,opacity,background-color,color] hover:bg-accent/70 hover:text-foreground data-[state=open]:ml-0 data-[state=open]:max-w-5 data-[state=open]:opacity-100`

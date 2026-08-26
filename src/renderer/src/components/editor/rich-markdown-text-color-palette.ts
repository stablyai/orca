export const RICH_MARKDOWN_TEXT_COLORS = [
  'gray',
  'red',
  'orange',
  'yellow',
  'green',
  'teal',
  'blue',
  'purple',
  'pink'
] as const

export type RichMarkdownTextColor = (typeof RICH_MARKDOWN_TEXT_COLORS)[number]

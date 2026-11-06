import { defaultSchema } from 'rehype-sanitize'

/** Tags sanitize keeps; any other tag is dropped or, with unknown HTML as text, shown literally. */
export const COMMENT_MARKDOWN_TAG_NAMES: readonly string[] = [
  ...(defaultSchema.tagNames ?? []),
  'details',
  'summary',
  'sub',
  'sup',
  'ins',
  'kbd'
]

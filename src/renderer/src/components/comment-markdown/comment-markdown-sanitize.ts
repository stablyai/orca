import { defaultSchema, type Options as SanitizeSchema } from 'rehype-sanitize'
import { defaultUrlTransform, type Options as MarkdownOptions } from 'react-markdown'
import { GITHUB_CALLOUT_SANITIZE_ATTRIBUTE } from '../../../../shared/github/markdown/github-callouts'
import { jiraImageReference } from '../../../../shared/jira/jira-attachment-image'

export function isTrustedCompactImageSrc(src: string | undefined): src is string {
  if (!src) {
    return false
  }
  const normalized = src.trim().toLowerCase()
  return (
    jiraImageReference(src) !== null ||
    normalized.startsWith('blob:') ||
    /^data:image\/(?:png|jpe?g|gif|webp);base64,/.test(normalized)
  )
}

type UrlTransform = NonNullable<MarkdownOptions['urlTransform']>

export const commentMarkdownUrlTransform: UrlTransform = (value, key, node) => {
  if (key === 'src' && node?.tagName === 'img' && isTrustedCompactImageSrc(value)) {
    return value
  }
  return defaultUrlTransform(value)
}

export const commentMarkdownSanitizeSchema: SanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), 'details', 'summary', 'sub', 'sup', 'ins', 'kbd'],
  attributes: {
    ...defaultSchema.attributes,
    a: [...(defaultSchema.attributes?.a ?? []), 'href', 'title'],
    blockquote: [
      ...(defaultSchema.attributes?.blockquote ?? []),
      GITHUB_CALLOUT_SANITIZE_ATTRIBUTE
    ],
    details: [...(defaultSchema.attributes?.details ?? []), 'open'],
    img: [...(defaultSchema.attributes?.img ?? []), 'src', 'alt', 'title', 'width', 'height'],
    input: [...(defaultSchema.attributes?.input ?? []), 'type', 'checked', 'disabled'],
    code: [
      ...(defaultSchema.attributes?.code ?? []),
      ['className', 'language-math', 'math-inline', 'math-display']
    ],
    span: [
      ...(defaultSchema.attributes?.span ?? []),
      ['className', 'language-math', 'math-inline', 'math-display', 'whitespace-pre-wrap']
    ],
    div: [
      ...(defaultSchema.attributes?.div ?? []),
      ['className', 'language-math', 'math-inline', 'math-display', 'whitespace-pre-wrap']
    ],
    td: [...(defaultSchema.attributes?.td ?? []), 'align'],
    th: [...(defaultSchema.attributes?.th ?? []), 'align']
  },
  protocols: {
    ...defaultSchema.protocols,
    // Allow file links through sanitize for native chat; other surfaces still strip them in URL transformation.
    href: [...(defaultSchema.protocols?.href ?? []), 'file'],
    src: [...(defaultSchema.protocols?.src ?? []), 'data', 'blob', 'orca-jira-image']
  }
}

export const commentMarkdownAllowedTagNames: ReadonlySet<string> = new Set(
  (commentMarkdownSanitizeSchema.tagNames ?? []).map((name) => name.toLowerCase())
)

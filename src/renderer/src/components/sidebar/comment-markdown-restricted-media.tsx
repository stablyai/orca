import type { CommentMarkdownExtension } from './CommentMarkdown'

function MediaLink({
  href,
  children
}: {
  href?: string
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <a
      href={href || undefined}
      target="_blank"
      rel="noreferrer"
      className="break-all text-primary underline underline-offset-2 hover:text-primary/80"
      onClick={(event) => event.stopPropagation()}
    >
      {children}
    </a>
  )
}

/** No media mounts, including GitHub video links that the document renderer normally embeds. */
export const restrictedMediaMarkdownExtension: CommentMarkdownExtension = {
  remarkPlugins: [],
  sanitizeAttributes: {},
  components: {
    a: MediaLink,
    img: ({ src, alt }) => (src ? <MediaLink href={src}>{alt || src}</MediaLink> : <>{alt}</>)
  }
}

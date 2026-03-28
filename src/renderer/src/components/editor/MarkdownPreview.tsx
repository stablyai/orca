import React from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkFrontmatter from 'remark-frontmatter'
import rehypeHighlight from 'rehype-highlight'
import type { Components } from 'react-markdown'
import { useAppStore } from '@/store'
import { getMarkdownPreviewImageSrc, getMarkdownPreviewLinkTarget } from './markdown-preview-links'

type MarkdownPreviewProps = {
  content: string
  filePath: string
}

export default function MarkdownPreview({
  content,
  filePath
}: MarkdownPreviewProps): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const isDark =
    settings?.theme === 'dark' ||
    (settings?.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)

  const components: Components = {
    a: ({ href, children, ...props }) => {
      const handleClick = (event: React.MouseEvent<HTMLAnchorElement>): void => {
        if (!href || href.startsWith('#')) {
          return
        }

        event.preventDefault()

        const target = getMarkdownPreviewLinkTarget(href, filePath)
        if (!target) {
          return
        }

        let parsed: URL
        try {
          parsed = new URL(target)
        } catch {
          return
        }

        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
          void window.api.shell.openUrl(parsed.toString())
          return
        }

        if (parsed.protocol === 'file:') {
          void window.api.shell.openFileUri(parsed.toString())
        }
      }

      return (
        <a {...props} href={href} onClick={handleClick}>
          {children}
        </a>
      )
    },
    img: ({ src, alt, ...props }) => (
      <img {...props} src={getMarkdownPreviewImageSrc(src, filePath)} alt={alt ?? ''} />
    )
  }

  return (
    <div
      className={`markdown-preview flex-1 min-h-0 overflow-auto ${isDark ? 'markdown-dark' : 'markdown-light'}`}
    >
      <div className="markdown-body">
        <Markdown
          components={components}
          remarkPlugins={[remarkGfm, remarkFrontmatter]}
          rehypePlugins={[rehypeHighlight]}
        >
          {content}
        </Markdown>
      </div>
    </div>
  )
}

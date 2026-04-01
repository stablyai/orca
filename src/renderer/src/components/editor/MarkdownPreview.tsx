import React, { useCallback, useEffect, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkFrontmatter from 'remark-frontmatter'
import rehypeHighlight from 'rehype-highlight'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import type { Components } from 'react-markdown'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useAppStore } from '@/store'
import { getMarkdownPreviewImageSrc, getMarkdownPreviewLinkTarget } from './markdown-preview-links'
import {
  applyMarkdownPreviewSearchHighlights,
  clearMarkdownPreviewSearchHighlights,
  isMarkdownPreviewFindShortcut,
  setActiveMarkdownPreviewSearchMatch
} from './markdown-preview-search'

type MarkdownPreviewProps = {
  content: string
  filePath: string
}

export default function MarkdownPreview({
  content,
  filePath
}: MarkdownPreviewProps): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const matchesRef = useRef<HTMLElement[]>([])
  const [isSearchOpen, setIsSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [matchCount, setMatchCount] = useState(0)
  const [activeMatchIndex, setActiveMatchIndex] = useState(-1)
  const settings = useAppStore((s) => s.settings)
  const isDark =
    settings?.theme === 'dark' ||
    (settings?.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)

  const moveToMatch = useCallback((direction: 1 | -1) => {
    const matches = matchesRef.current
    if (matches.length === 0) {
      return
    }
    setActiveMatchIndex((currentIndex) => {
      const baseIndex = currentIndex >= 0 ? currentIndex : direction === 1 ? -1 : 0
      const nextIndex = (baseIndex + direction + matches.length) % matches.length
      return nextIndex
    })
  }, [])

  const closeSearch = useCallback(() => {
    setIsSearchOpen(false)
    setQuery('')
    setActiveMatchIndex(-1)
  }, [])

  useEffect(() => {
    if (isSearchOpen) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [isSearchOpen])

  useEffect(() => {
    const body = bodyRef.current
    if (!body) {
      return
    }

    if (!isSearchOpen) {
      matchesRef.current = []
      setMatchCount(0)
      clearMarkdownPreviewSearchHighlights(body)
      return
    }

    // Search decorations are applied imperatively because the rendered preview is
    // already owned by react-markdown. Rewriting the markdown AST for transient
    // find state would make navigation and link rendering much harder to reason about.
    const matches = applyMarkdownPreviewSearchHighlights(body, query)
    matchesRef.current = matches
    setMatchCount(matches.length)
    setActiveMatchIndex((currentIndex) => {
      if (matches.length === 0) {
        return -1
      }
      if (currentIndex >= 0 && currentIndex < matches.length) {
        return currentIndex
      }
      return 0
    })

    return () => clearMarkdownPreviewSearchHighlights(body)
  }, [content, isSearchOpen, query])

  useEffect(() => {
    setActiveMarkdownPreviewSearchMatch(matchesRef.current, activeMatchIndex)
  }, [activeMatchIndex, matchCount])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      const root = rootRef.current
      if (!root) {
        return
      }

      const target = event.target
      const targetInsidePreview = target instanceof Node && root.contains(target)
      const targetIsEditable =
        target instanceof HTMLElement &&
        (target.isContentEditable || target.closest('input, textarea, select') !== null)

      if (
        isMarkdownPreviewFindShortcut(event, navigator.userAgent.includes('Mac')) &&
        (isSearchOpen || targetInsidePreview || !targetIsEditable)
      ) {
        event.preventDefault()
        event.stopPropagation()
        setIsSearchOpen(true)
        return
      }

      if (!isSearchOpen) {
        return
      }

      if (event.key === 'Escape' && (targetInsidePreview || target === inputRef.current)) {
        event.preventDefault()
        event.stopPropagation()
        closeSearch()
        root.focus()
      }
    }

    window.addEventListener('keydown', handleKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true })
  }, [closeSearch, isSearchOpen, setIsSearchOpen])

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
      ref={rootRef}
      tabIndex={0}
      className={`markdown-preview h-full min-h-0 overflow-auto scrollbar-editor ${isDark ? 'markdown-dark' : 'markdown-light'}`}
    >
      {isSearchOpen ? (
        <div className="markdown-preview-search" onKeyDown={(event) => event.stopPropagation()}>
          <div className="markdown-preview-search-field">
            <Input
              ref={inputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && event.shiftKey) {
                  event.preventDefault()
                  moveToMatch(-1)
                  return
                }
                if (event.key === 'Enter') {
                  event.preventDefault()
                  moveToMatch(1)
                  return
                }
                if (event.key === 'Escape') {
                  event.preventDefault()
                  closeSearch()
                  rootRef.current?.focus()
                }
              }}
              placeholder="Find in preview"
              className="markdown-preview-search-input h-7 !border-0 bg-transparent px-2 shadow-none focus-visible:!border-0 focus-visible:ring-0"
              aria-label="Find in markdown preview"
            />
          </div>
          <div className="markdown-preview-search-status">
            {query && matchCount === 0
              ? 'No results'
              : `${matchCount === 0 ? 0 : activeMatchIndex + 1}/${matchCount}`}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={() => moveToMatch(-1)}
            disabled={matchCount === 0}
            title="Previous match"
            aria-label="Previous match"
            className="markdown-preview-search-button"
          >
            <ChevronUp size={14} />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={() => moveToMatch(1)}
            disabled={matchCount === 0}
            title="Next match"
            aria-label="Next match"
            className="markdown-preview-search-button"
          >
            <ChevronDown size={14} />
          </Button>
          <div className="markdown-preview-search-divider" />
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={closeSearch}
            title="Close search"
            aria-label="Close search"
            className="markdown-preview-search-button"
          >
            <X size={14} />
          </Button>
        </div>
      ) : null}
      <div ref={bodyRef} className="markdown-body">
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

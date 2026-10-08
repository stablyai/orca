import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import CommentMarkdown from './CommentMarkdown'
import { MarkdownPreviewBody } from '@/components/editor/MarkdownPreviewBody'
import { NativeChatCodeBlock } from '@/components/native-chat/NativeChatCodeBlock'
import { NativeChatMarkdown } from '@/components/native-chat/NativeChatMarkdown'

function renderComment(content: string, variant: 'compact' | 'document' = 'document'): string {
  return renderToStaticMarkup(<CommentMarkdown variant={variant} content={content} />)
}

describe('GitHub callouts', () => {
  it.each(['compact', 'document'] as const)(
    'renders a %s quote that opens with a marker as a titled callout',
    (variant) => {
      const markup = renderComment('> [!NOTE]\n> The content of the note.', variant)

      expect(markup).toContain('data-callout="note"')
      expect(markup).toContain('Note')
      expect(markup).not.toContain('[!NOTE]')
      expect(markup).not.toContain('<blockquote')
      expect(markup).toContain('The content of the note.')
    }
  )

  it('keeps blocks that follow a marker-only paragraph', () => {
    const markup = renderComment('> [!WARNING]\n>\n> ### A heading\n>\n> And a paragraph.')

    expect(markup).toContain('data-callout="warning"')
    expect(markup).not.toContain('[!WARNING]')
    expect(markup).toContain('A heading')
    expect(markup).toContain('And a paragraph.')
  })

  it('keeps a body line that opens with inline formatting', () => {
    const markup = renderComment('> [!tip]\n> **Medium Risk** Changes transcript routing.')

    expect(markup).toContain('data-callout="tip"')
    expect(markup).toContain('<strong>Medium Risk</strong>')
    expect(markup).toContain('Changes transcript routing.')
  })

  it.each([
    ['text sharing the marker line', '> [!NOTE] an ordinary quote', '[!NOTE] an ordinary quote'],
    ['inline formatting sharing the marker line', '> [!NOTE]*aside*', '[!NOTE]'],
    ['an unknown marker', "> [!DANGER]\n> Not one of GitHub's.", '[!DANGER]']
  ])('leaves a quote with %s alone', (_name, content, literal) => {
    const markup = renderComment(content)

    expect(markup).not.toContain('data-callout')
    expect(markup).toContain('<blockquote')
    expect(markup).toContain(literal)
  })

  it('renders callouts in native chat assistant messages', () => {
    const markup = renderToStaticMarkup(
      <NativeChatMarkdown
        content={'Done.\n\n> [!IMPORTANT]\n> Restart the app to pick up `config.ts`.'}
        variant="document"
        renderCodeBlock={NativeChatCodeBlock}
        onLinkClick={() => {}}
        linkifyFilePaths
      />
    )

    expect(markup).toContain('data-callout="important"')
    expect(markup).toContain('Important')
    expect(markup).not.toContain('[!IMPORTANT]')
    expect(markup).toContain('Restart the app to pick up')
  })

  it('renders callouts in the markdown preview', () => {
    const markup = renderToStaticMarkup(
      <MarkdownPreviewBody content={'> [!CAUTION]\n> Irreversible.'} components={{}} />
    )

    expect(markup).toContain('data-callout="caution"')
    expect(markup).not.toContain('[!CAUTION]')
    expect(markup).toContain('Irreversible.')
  })
})

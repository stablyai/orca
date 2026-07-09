// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

// Why: real useRepoById returns a Repo with `displayName`, not `name` — mock matches the real shape.
const useActiveWorktree = vi.fn(() => ({ id: 'w1', path: '/repo', repoId: 'r1' }))
vi.mock('@/store/selectors', () => ({
  useActiveWorktree: () => useActiveWorktree(),
  useRepoById: () => ({ id: 'r1', displayName: 'my-repo' })
}))
// Why: exposes onLinkClick so tests can drive real link-click navigation
// through the component instead of asserting on props in isolation. The link
// target is parsed out of the (already-converted) content so a test can
// verify a wikilink was actually turned into a resolvable markdown link,
// falling back to 'Other.md' for fixtures with no link in their content.
vi.mock('@/components/sidebar/CommentMarkdown', () => ({
  __esModule: true,
  default: ({
    content,
    onLinkClick
  }: {
    content: string
    onLinkClick?: (event: { preventDefault: () => void }, href: string) => void
  }) => {
    const linkMatch = content.match(/\[([^\]]+)\]\(([^)]+)\)/)
    const href = linkMatch?.[2] ?? 'Other.md'
    return (
      <div data-testid="md">
        {content}
        <a data-testid="wiki-link" href={href} onClick={(event) => onLinkClick?.(event, href)}>
          link
        </a>
      </div>
    )
  }
}))

import WikiPanel from './WikiPanel'

const read = vi.fn()
const generate = vi.fn()
const generationStatus = vi.fn()
const cancelGeneration = vi.fn()
const onGenerationChanged = vi.fn()
let generationChangedCallback:
  | ((payload: {
      worktreeId: string
      running: boolean
      output: string
      error?: string
      done?: boolean
    }) => void)
  | null = null

beforeEach(() => {
  read.mockReset()
  generate.mockReset()
  generationStatus.mockReset()
  cancelGeneration.mockReset()
  onGenerationChanged.mockReset()
  generationChangedCallback = null
  generationStatus.mockResolvedValue(null)
  cancelGeneration.mockResolvedValue({ ok: true })
  onGenerationChanged.mockImplementation((callback) => {
    generationChangedCallback = callback
    return () => {}
  })
  useActiveWorktree.mockReturnValue({ id: 'w1', path: '/repo', repoId: 'r1' })
  globalThis.window.api = {
    wiki: { read, generate, generationStatus, cancelGeneration, onGenerationChanged }
  } as unknown as Window['api']
})
afterEach(() => cleanup())

describe('WikiPanel', () => {
  it('shows the generate button when no wiki exists', async () => {
    read.mockResolvedValue({ hasWiki: false })
    render(<WikiPanel />)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /generate wiki/i })).toBeInTheDocument()
    )
  })
  it('renders the root note when a wiki exists', async () => {
    read.mockResolvedValue({
      hasWiki: true,
      rootRelativePath: 'Home.md',
      note: { relativePath: 'Home.md', content: '# Home' }
    })
    render(<WikiPanel />)
    await waitFor(() => expect(screen.getByTestId('md')).toHaveTextContent('# Home'))
  })
  it('calls generate with the CLAUDE.md checkbox enabled by default', async () => {
    read.mockResolvedValue({ hasWiki: false })
    generate.mockResolvedValue({ ok: true })
    const { getByRole } = render(<WikiPanel />)
    await waitFor(() => getByRole('button', { name: /generate wiki/i }))
    expect(screen.getByText(/add wiki instruction to claude\.md/i)).toBeInTheDocument()
    expect(getByRole('checkbox')).toBeInTheDocument()
    getByRole('button', { name: /generate wiki/i }).click()
    await waitFor(() =>
      expect(generate).toHaveBeenCalledWith({ worktreeId: 'w1', addClaudeMdInstruction: true })
    )
  })

  it('passes addClaudeMdInstruction:false when the checkbox is unchecked', async () => {
    read.mockResolvedValue({ hasWiki: false })
    generate.mockResolvedValue({ ok: true })
    const { getByRole } = render(<WikiPanel />)
    await waitFor(() => getByRole('button', { name: /generate wiki/i }))
    fireEvent.click(getByRole('checkbox'))
    getByRole('button', { name: /generate wiki/i }).click()
    await waitFor(() =>
      expect(generate).toHaveBeenCalledWith({ worktreeId: 'w1', addClaudeMdInstruction: false })
    )
  })

  it('hides frontmatter and renders a wikilink as a clickable link that resolves via wiki:read', async () => {
    read.mockResolvedValueOnce({
      hasWiki: true,
      rootRelativePath: 'Home.md',
      note: {
        relativePath: 'Home.md',
        content: '---\ntags:\n  - topic/meta\n---\nSee [[Feature]] for details.'
      }
    })
    render(<WikiPanel />)
    await waitFor(() => expect(screen.getByTestId('md')).toHaveTextContent('See'))

    const rendered = screen.getByTestId('md')
    expect(rendered).not.toHaveTextContent('topic/meta')
    expect(rendered).not.toHaveTextContent('---')
    expect(rendered).toHaveTextContent('[Feature](Feature)')

    read.mockResolvedValueOnce({
      hasWiki: true,
      rootRelativePath: 'Home.md',
      note: { relativePath: 'Feature.md', content: '# Feature' }
    })
    screen.getByTestId('wiki-link').click()

    await waitFor(() => expect(screen.getByTestId('md')).toHaveTextContent('# Feature'))
    expect(read).toHaveBeenLastCalledWith({
      worktreeId: 'w1',
      target: 'Feature',
      fromRelativePath: 'Home.md'
    })
  })

  it('follows an internal link by reading the target note in-panel', async () => {
    read.mockResolvedValueOnce({
      hasWiki: true,
      rootRelativePath: 'Home.md',
      note: { relativePath: 'Home.md', content: '# Home' }
    })
    render(<WikiPanel />)
    await waitFor(() => expect(screen.getByTestId('md')).toHaveTextContent('# Home'))

    read.mockResolvedValueOnce({
      hasWiki: true,
      rootRelativePath: 'Home.md',
      note: { relativePath: 'Other.md', content: '# Other' }
    })
    screen.getByTestId('wiki-link').click()

    await waitFor(() => expect(screen.getByTestId('md')).toHaveTextContent('# Other'))
    expect(read).toHaveBeenLastCalledWith({
      worktreeId: 'w1',
      target: 'Other.md',
      fromRelativePath: 'Home.md'
    })
  })

  it('resumes the generating state on mount when the main process reports a running generation', async () => {
    // Why: this proves persistence-on-return — no generate click, phase comes
    // straight from wiki:generationStatus, so switching tabs away and back
    // does not lose progress.
    generationStatus.mockResolvedValue({ running: true, output: 'working on it…' })
    render(<WikiPanel />)
    await waitFor(() => expect(screen.getByRole('button', { name: /stop/i })).toBeInTheDocument())
    expect(screen.getByText('working on it…')).toBeInTheDocument()
    expect(read).not.toHaveBeenCalled()
  })

  it('shows the error state on mount when the main process reports a finished, failed generation', async () => {
    generationStatus.mockResolvedValue({
      running: false,
      output: '',
      error: 'Agent exited with code 1.'
    })
    render(<WikiPanel />)
    await waitFor(() => expect(screen.getByText('Agent exited with code 1.')).toBeInTheDocument())
  })

  it('clicking Stop calls cancelGeneration for the active worktree', async () => {
    generationStatus.mockResolvedValue({ running: true, output: '' })
    render(<WikiPanel />)
    const stopButton = await screen.findByRole('button', { name: /stop/i })
    stopButton.click()
    await waitFor(() => expect(cancelGeneration).toHaveBeenCalledWith({ worktreeId: 'w1' }))
  })

  it('re-reads and shows content when onGenerationChanged fires done:true', async () => {
    generationStatus.mockResolvedValue({ running: true, output: 'still going' })
    read.mockResolvedValue({
      hasWiki: true,
      rootRelativePath: 'Home.md',
      note: { relativePath: 'Home.md', content: '# Home' }
    })
    render(<WikiPanel />)
    await waitFor(() => expect(screen.getByRole('button', { name: /stop/i })).toBeInTheDocument())

    generationChangedCallback?.({ worktreeId: 'w1', running: false, output: 'done', done: true })

    await waitFor(() => expect(screen.getByTestId('md')).toHaveTextContent('# Home'))
  })

  it('discards a slow prior read after the worktree changes', async () => {
    let resolveFirst!: (value: unknown) => void
    read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve
        })
    )
    const { rerender } = render(<WikiPanel />)
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1))

    // Why: switching worktree bumps the request token before the slow first
    // read settles, so its late resolution must not clobber worktree w2.
    useActiveWorktree.mockReturnValue({ id: 'w2', path: '/repo2', repoId: 'r2' })
    read.mockResolvedValueOnce({
      hasWiki: true,
      rootRelativePath: 'Home2.md',
      note: { relativePath: 'Home2.md', content: '# Home Two' }
    })
    rerender(<WikiPanel />)
    await waitFor(() => expect(screen.getByTestId('md')).toHaveTextContent('# Home Two'))

    resolveFirst({
      hasWiki: true,
      rootRelativePath: 'Home1.md',
      note: { relativePath: 'Home1.md', content: '# Home One' }
    })

    await Promise.resolve()
    await Promise.resolve()
    expect(screen.getByTestId('md')).toHaveTextContent('# Home Two')
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CommitArea } from './SourceControl'
import { Button } from '@/components/ui/button'

type ReactElementLike = {
  type: unknown
  props: Record<string, unknown>
}

function visit(node: unknown, cb: (node: ReactElementLike) => void): void {
  if (node == null || typeof node === 'string' || typeof node === 'number') {
    return
  }
  if (Array.isArray(node)) {
    node.forEach((entry) => visit(entry, cb))
    return
  }
  const element = node as ReactElementLike
  cb(element)
  if (element.props?.children) {
    visit(element.props.children, cb)
  }
}

function findTextarea(node: unknown): ReactElementLike {
  let found: ReactElementLike | null = null
  visit(node, (entry) => {
    if (entry.type === 'textarea') {
      found = entry
    }
  })
  if (!found) {
    throw new Error('textarea not found')
  }
  return found
}

function findCommitButton(node: unknown): ReactElementLike {
  let found: ReactElementLike | null = null
  visit(node, (entry) => {
    if (entry.type === Button) {
      found = entry
    }
  })
  if (!found) {
    throw new Error('commit button not found')
  }
  return found
}

function hasText(node: unknown, text: string): boolean {
  let found = false
  visit(node, (entry) => {
    const children = entry.props?.children
    if (typeof children === 'string' && children.includes(text)) {
      found = true
    }
  })
  return found
}

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

const baseProps = {
  stagedCount: 1,
  hasUnresolvedConflicts: false,
  commitMessage: 'feat: add commit area',
  commitError: null as string | null,
  isCommitting: false,
  branchName: 'main',
  onCommitMessageChange: vi.fn(),
  onCommitSuccess: vi.fn()
}

describe('CommitArea', () => {
  beforeEach(() => {
    vi.stubGlobal('navigator', { userAgent: 'Macintosh' })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('disables commit button when no staged files', () => {
    const element = CommitArea({ ...baseProps, stagedCount: 0 })
    const button = findCommitButton(element)
    expect(button.props.disabled).toBe(true)
  })

  it('disables commit button when message is empty', () => {
    const element = CommitArea({ ...baseProps, commitMessage: '   ' })
    const button = findCommitButton(element)
    expect(button.props.disabled).toBe(true)
  })

  it('disables commit button when unresolved conflicts exist', () => {
    const element = CommitArea({ ...baseProps, hasUnresolvedConflicts: true })
    const button = findCommitButton(element)
    expect(button.props.disabled).toBe(true)
  })

  it('enables commit button with staged files, message, and no conflicts', () => {
    const element = CommitArea(baseProps)
    const button = findCommitButton(element)
    expect(button.props.disabled).toBe(false)
  })

  it('triggers commit on Ctrl+Enter shortcut for non-macOS', () => {
    vi.stubGlobal('navigator', { userAgent: 'Windows' })

    const onCommitSuccess = vi.fn()
    const element = CommitArea({ ...baseProps, onCommitSuccess })
    const textarea = findTextarea(element)

    const preventDefault = vi.fn()
    ;(textarea.props.onKeyDown as (event: unknown) => void)({
      metaKey: false,
      ctrlKey: true,
      key: 'Enter',
      preventDefault
    })

    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(onCommitSuccess).toHaveBeenCalledTimes(1)
  })

  it('does not trigger shortcut submit when commit is disabled', () => {
    const onCommitSuccess = vi.fn()
    const element = CommitArea({ ...baseProps, commitMessage: '   ', onCommitSuccess })
    const textarea = findTextarea(element)

    ;(textarea.props.onKeyDown as (event: unknown) => void)({
      metaKey: true,
      ctrlKey: false,
      key: 'Enter',
      preventDefault: vi.fn()
    })

    expect(onCommitSuccess).not.toHaveBeenCalled()
  })

  it('clears message and keeps error hidden after successful commit lifecycle', async () => {
    let commitMessage = 'feat: add commit area'
    let commitError: string | null = null
    let isCommitting = false

    const runCommit = vi.fn(async () => {
      isCommitting = true
      commitError = null
      await Promise.resolve()
      commitMessage = ''
      isCommitting = false
    })

    const render = () =>
      CommitArea({
        ...baseProps,
        commitMessage,
        commitError,
        isCommitting,
        onCommitSuccess: () => {
          void runCommit()
        }
      })

    const textarea = findTextarea(render())
    ;(textarea.props.onKeyDown as (event: unknown) => void)({
      metaKey: true,
      ctrlKey: false,
      key: 'Enter',
      preventDefault: vi.fn()
    })
    await flushPromises()

    const updated = render()
    expect(findTextarea(updated).props.value).toBe('')
    expect(hasText(updated, 'failed')).toBe(false)
    expect(runCommit).toHaveBeenCalledTimes(1)
  })

  it('preserves message and shows error after failed commit lifecycle', async () => {
    const initialMessage = 'feat: add commit area'
    let commitMessage = initialMessage
    let commitError: string | null = null
    let isCommitting = false

    const runCommit = vi.fn(async () => {
      isCommitting = true
      commitError = null
      await Promise.resolve()
      commitError = 'pre-commit hook failed'
      isCommitting = false
    })

    const render = () =>
      CommitArea({
        ...baseProps,
        commitMessage,
        commitError,
        isCommitting,
        onCommitSuccess: () => {
          void runCommit()
        }
      })

    const textarea = findTextarea(render())
    ;(textarea.props.onKeyDown as (event: unknown) => void)({
      metaKey: true,
      ctrlKey: false,
      key: 'Enter',
      preventDefault: vi.fn()
    })
    await flushPromises()

    const updated = render()
    expect(findTextarea(updated).props.value).toBe(initialMessage)
    expect(hasText(updated, 'pre-commit hook failed')).toBe(true)
    expect(runCommit).toHaveBeenCalledTimes(1)
  })

  it('locks interactions while commit is in flight', () => {
    const onCommitSuccess = vi.fn()
    const element = CommitArea({ ...baseProps, isCommitting: true, onCommitSuccess })
    const button = findCommitButton(element)
    expect(button.props.disabled).toBe(true)

    const textarea = findTextarea(element)
    ;(textarea.props.onKeyDown as (event: unknown) => void)({
      metaKey: true,
      ctrlKey: false,
      key: 'Enter',
      preventDefault: vi.fn()
    })
    expect(onCommitSuccess).not.toHaveBeenCalled()
  })

  it('shows an inline error message when commit fails', () => {
    const element = CommitArea({ ...baseProps, commitError: 'pre-commit hook failed' })
    expect(hasText(element, 'pre-commit hook failed')).toBe(true)
  })
})

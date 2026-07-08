import React from 'react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { BrowserAnnotationSendMenuContent } from './BrowserAnnotationSendMenuContent'

type ReactElementLike = {
  type: unknown
  props: Record<string, unknown>
}

vi.mock('@/components/editor/ReviewNotesSendMenuContent', () => ({
  ReviewNotesSendMenuContent: function ReviewNotesSendMenuContent(props: Record<string, unknown>) {
    return { type: 'ReviewNotesSendMenuContent', props }
  }
}))

function expand(node: unknown): unknown {
  if (node == null || typeof node === 'string' || typeof node === 'number') {
    return node
  }
  if (Array.isArray(node)) {
    return node.map((entry) => expand(entry))
  }
  if (!React.isValidElement(node)) {
    if (typeof node === 'object' && 'props' in node) {
      const element = node as ReactElementLike
      return {
        ...element,
        props: {
          ...element.props,
          children: expand(element.props.children)
        }
      }
    }
    return node
  }
  const element = node as React.ReactElement<Record<string, unknown>>
  if (typeof element.type === 'function') {
    const Component = element.type as (props: Record<string, unknown>) => unknown
    return expand(Component(element.props))
  }
  return {
    type: element.type,
    props: {
      ...element.props,
      children: expand(element.props.children)
    }
  }
}

function findByType(node: unknown, type: string): ReactElementLike {
  if (node && typeof node === 'object' && 'type' in node) {
    const element = node as ReactElementLike
    if (element.type === type) {
      return element
    }
    const children = element.props.children
    if (Array.isArray(children)) {
      for (const child of children) {
        try {
          return findByType(child, type)
        } catch {
          // Continue searching siblings.
        }
      }
    } else if (children) {
      return findByType(children, type)
    }
  }
  throw new Error(`Unable to find ${type}`)
}

describe('BrowserAnnotationSendMenuContent', () => {
  it('uses the review notes send content so existing agent sessions are selectable', () => {
    const onPromptDelivered = vi.fn()
    const tree = expand(
      <BrowserAnnotationSendMenuContent
        worktreeId="wt-1"
        groupId="group-1"
        prompt="browser annotation prompt"
        onPromptDelivered={onPromptDelivered}
      />
    )

    expect(findByType(tree, 'ReviewNotesSendMenuContent').props).toMatchObject({
      worktreeId: 'wt-1',
      groupId: 'group-1',
      prompt: 'browser annotation prompt',
      promptDelivery: 'submit-after-ready',
      launchSource: 'notes_send',
      onPromptDelivered
    })
  })

  it('is wired into both browser annotation send surfaces', () => {
    const browserPaneSource = readFileSync(
      fileURLToPath(new URL('./BrowserPane.tsx', import.meta.url)),
      'utf8'
    )

    expect(browserPaneSource.match(/<BrowserAnnotationSendMenuContent\b/g)).toHaveLength(2)
    expect(browserPaneSource).not.toContain('<QuickLaunchAgentMenuItems')
  })
})

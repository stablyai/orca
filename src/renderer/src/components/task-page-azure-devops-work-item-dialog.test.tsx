// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { describe, expect, it, vi, afterEach } from 'vitest'
import type { AzureDevOpsWorkItemDetail } from '../../../shared/azure-devops/boards-types'
import {
  AzureDevOpsWorkItemDialog,
  sanitizeAzureDevOpsHtml
} from '@/components/task-page/azure-devops/WorkItemDialog'

// Why: DOMPurify is inert under happy-dom (returns input untouched), so the mock keeps the
// tag-stripping contract; the instance/global split is what the isolation test asserts.
const { privateInstance, globalAddHook } = vi.hoisted(() => {
  const sanitize = vi.fn((html: string, _options?: Record<string, unknown>) =>
    html
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
      .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '')
      .replace(/<embed\b[^<]*>/gi, '')
      .replace(/<object\b[^<]*(?:(?!<\/object>)<[^<]*)*<\/object>/gi, '')
  )
  return {
    privateInstance: { sanitize, addHook: vi.fn() },
    globalAddHook: vi.fn()
  }
})
vi.mock('dompurify', () => ({
  default: Object.assign(() => privateInstance, {
    sanitize: (html: string) => html,
    addHook: globalAddHook
  })
}))

afterEach(() => cleanup())

const detail: AzureDevOpsWorkItemDetail = {
  id: 288,
  rev: 1,
  workItemType: 'Product Backlog Item',
  title: 'Phase 2',
  state: 'Committed',
  assignedTo: { displayName: 'Bobo', uniqueName: 'b@x', imageUrl: null },
  areaPath: 'P\\pos',
  iterationPath: 'P\\2026',
  tags: ['ready'],
  parentId: 70,
  stackRank: 1,
  url: 'https://dev.azure.com/acme/Project/_workitems/edit/288',
  fields: {},
  descriptionHtml: '<p>Hello <script>alert(1)</script><b>world</b></p>',
  acceptanceCriteriaHtml: '<ul><li>done</li></ul>',
  childIds: [301],
  pullRequestLinks: [
    { id: 171, url: 'https://dev.azure.com/acme/Project/_git/repo/pullrequest/171' }
  ],
  createdDate: null,
  changedDate: null
}

describe('sanitizeAzureDevOpsHtml', () => {
  it('strips scripts and keeps formatting', () => {
    const html = sanitizeAzureDevOpsHtml(detail.descriptionHtml!)
    expect(html).not.toContain('<script')
    expect(html).toContain('<b>world</b>')
  })

  it('forbids the form controls the html profile would otherwise keep', () => {
    sanitizeAzureDevOpsHtml('<p>x</p>')
    const options = privateInstance.sanitize.mock.calls.at(-1)?.[1]
    expect(options?.FORBID_TAGS).toEqual(
      expect.arrayContaining(['form', 'input', 'button', 'select', 'textarea'])
    )
    expect(options?.FORBID_ATTR).toEqual(expect.arrayContaining(['action', 'formaction']))
  })

  it('registers the external-link hook on a private instance, never on the global one', () => {
    sanitizeAzureDevOpsHtml('<a href="https://example.com">x</a>')
    expect(privateInstance.addHook).toHaveBeenCalledWith(
      'afterSanitizeAttributes',
      expect.any(Function)
    )
    expect(globalAddHook).not.toHaveBeenCalled()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the sanitiser registers exactly one node hook, which DOMPurify calls with an Element.
    const hook = privateInstance.addHook.mock.calls[0][1] as (node: Element) => void
    const anchor = document.createElement('a')
    hook(anchor)
    expect(anchor.getAttribute('target')).toBe('_blank')
    expect(anchor.getAttribute('rel')).toBe('noopener noreferrer')
  })
})

describe('AzureDevOpsWorkItemDialog', () => {
  it('renders header fields, sanitized body, relations and the Use action', () => {
    const onUseItem = vi.fn()
    render(
      <AzureDevOpsWorkItemDialog
        open
        onOpenChange={vi.fn()}
        detail={detail}
        loading={false}
        error={null}
        workItemTypes={{}}
        tagColors={{ ready: '#339933' }}
        parent={{ ...detail, id: 70, workItemType: 'Feature', title: 'Parent feature' }}
        childItems={[{ ...detail, id: 301, workItemType: 'Task', title: 'Child task' }]}
        onOpenItem={vi.fn()}
        onUseItem={onUseItem}
      />
    )
    expect(screen.getByText('Phase 2')).toBeInTheDocument()
    expect(screen.getByText('288')).toBeInTheDocument()
    expect(screen.getByText('world')).toBeInTheDocument()
    expect(screen.queryByText('alert(1)')).not.toBeInTheDocument()
    expect(screen.getByText('done')).toBeInTheDocument()
    expect(screen.getByText('Parent feature')).toBeInTheDocument()
    expect(screen.getByText('Child task')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /171/ })).toHaveAttribute(
      'href',
      detail.pullRequestLinks[0].url
    )
    fireEvent.click(screen.getByRole('button', { name: /Use in a worktree/ }))
    expect(onUseItem).toHaveBeenCalledWith(288)
  })

  it('shows a loading state before the detail arrives', () => {
    render(
      <AzureDevOpsWorkItemDialog
        open
        onOpenChange={vi.fn()}
        detail={null}
        loading
        error={null}
        workItemTypes={{}}
        tagColors={{}}
        parent={null}
        childItems={[]}
        onOpenItem={vi.fn()}
        onUseItem={vi.fn()}
      />
    )
    expect(screen.getByText('Loading work item…')).toBeInTheDocument()
  })
})

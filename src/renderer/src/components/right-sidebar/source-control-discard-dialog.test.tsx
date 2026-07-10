import { renderToStaticMarkup } from 'react-dom/server'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitStatusEntry } from '../../../../shared/types'

type CapturedButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  children?: ReactNode
  variant?: string
}

const mocks = vi.hoisted(() => ({
  buttons: [] as CapturedButtonProps[],
  dialogContentProps: [] as Record<string, unknown>[]
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({
    children,
    ...props
  }: {
    children: ReactNode
    onOpenAutoFocus?: (event: Event) => void
  }) => {
    mocks.dialogContentProps.push(props)
    return <div>{children}</div>
  },
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <footer>{children}</footer>,
  DialogHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>
}))

vi.mock('@/components/ui/button', async () => {
  const ReactModule = await import('react')
  return {
    Button: ReactModule.forwardRef<HTMLButtonElement, CapturedButtonProps>(function Button(
      { children, variant: _variant, ...props },
      ref
    ) {
      mocks.buttons.push({ ...props, variant: _variant, children })
      return (
        <button {...props} ref={ref}>
          {children}
        </button>
      )
    })
  }
})

function entry(partial: Partial<GitStatusEntry> & { path: string }): GitStatusEntry {
  return {
    area: 'unstaged',
    status: 'modified',
    ...partial
  }
}

function textContent(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') {
    return ''
  }
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node)
  }
  if (Array.isArray(node)) {
    return node.map(textContent).join('')
  }
  if (typeof node === 'object' && 'props' in node) {
    return textContent((node as { props?: { children?: ReactNode } }).props?.children)
  }
  return ''
}

describe('SourceControlDiscardDialog', () => {
  beforeEach(() => {
    mocks.buttons = []
    mocks.dialogContentProps = []
  })

  it('makes the discard button the dialog default action', async () => {
    const { SourceControlDiscardDialog } = await import('./source-control-discard-dialog')

    renderToStaticMarkup(
      <SourceControlDiscardDialog
        pendingDiscard={{
          kind: 'entry',
          entry: entry({ path: 'src/changed.ts', status: 'modified' })
        }}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />
    )

    const cancelButton = mocks.buttons.find((button) => textContent(button.children) === 'Cancel')
    const discardButton = mocks.buttons.find((button) =>
      textContent(button.children).includes('Discard')
    )

    expect(cancelButton?.autoFocus).not.toBe(true)
    expect(discardButton?.variant).toBe('destructive')
    expect(discardButton?.autoFocus).toBe(true)
    expect(mocks.dialogContentProps[0]?.onOpenAutoFocus).toEqual(expect.any(Function))
  })
})

describe('focusDiscardDialogConfirmButton', () => {
  it('prevents Radix from focusing the first tabbable button', async () => {
    const { focusDiscardDialogConfirmButton } = await import('./source-control-discard-dialog')
    const event = { preventDefault: vi.fn() } as unknown as Event
    const confirmButton = { focus: vi.fn() } as unknown as HTMLButtonElement

    focusDiscardDialogConfirmButton(event, confirmButton)

    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(confirmButton.focus).toHaveBeenCalledTimes(1)
  })
})

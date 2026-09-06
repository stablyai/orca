import { renderToStaticMarkup } from 'react-dom/server'
import type * as ReactModule from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type ButtonCapture = {
  label: string
  onClick?: () => unknown
  disabled?: boolean
}

const mocks = vi.hoisted(() => ({
  buttons: [] as ButtonCapture[],
  state: {
    activeModal: 'confirm-workspace-trust',
    modalData: {} as Record<string, unknown>,
    closeModal: vi.fn()
  }
}))

function textContent(node: ReactModule.ReactNode): string {
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
    return textContent((node as { props?: { children?: ReactModule.ReactNode } }).props?.children)
  }
  return ''
}

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state),
    { getState: () => mocks.state }
  )
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactModule.ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: ReactModule.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactModule.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactModule.ReactNode }) => <footer>{children}</footer>,
  DialogHeader: ({ children }: { children: ReactModule.ReactNode }) => <header>{children}</header>,
  DialogTitle: ({ children }: { children: ReactModule.ReactNode }) => <h1>{children}</h1>
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    onClick,
    disabled
  }: {
    children: ReactModule.ReactNode
    onClick?: () => unknown
    disabled?: boolean
  }) => {
    mocks.buttons.push({ label: textContent(children), onClick, disabled })
    return (
      <button disabled={disabled} onClick={onClick}>
        {children}
      </button>
    )
  }
}))

function getButton(label: string): ButtonCapture {
  const button = mocks.buttons.find((entry) => entry.label.includes(label))
  if (!button?.onClick) {
    throw new Error(`${label} button not found`)
  }
  return button
}

describe('WorkspaceTrustPromptDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.buttons = []
    mocks.state.activeModal = 'confirm-workspace-trust'
    mocks.state.modalData = {
      path: '/home/user/work/proj',
      onResolve: vi.fn()
    }
  })

  it('states the exact path and offers trusting the parent as an explicit alternative', async () => {
    const { default: WorkspaceTrustPromptDialog } = await import('./WorkspaceTrustPromptDialog')

    const markup = renderToStaticMarkup(<WorkspaceTrustPromptDialog />)

    expect(markup).toContain('/home/user/work/proj')
    expect(markup).toContain('/home/user/work')
  })

  it('resolves trust-workspace when the primary action is chosen', async () => {
    const { default: WorkspaceTrustPromptDialog } = await import('./WorkspaceTrustPromptDialog')
    renderToStaticMarkup(<WorkspaceTrustPromptDialog />)

    await getButton('Trust this location').onClick?.()

    expect(mocks.state.modalData.onResolve).toHaveBeenCalledWith('trust-workspace')
    expect(mocks.state.closeModal).toHaveBeenCalledTimes(1)
  })

  it('resolves trust-parent when the parent alternative is chosen', async () => {
    const { default: WorkspaceTrustPromptDialog } = await import('./WorkspaceTrustPromptDialog')
    renderToStaticMarkup(<WorkspaceTrustPromptDialog />)

    await getButton('/home/user/work').onClick?.()

    expect(mocks.state.modalData.onResolve).toHaveBeenCalledWith('trust-parent')
    expect(mocks.state.closeModal).toHaveBeenCalledTimes(1)
  })

  it('resolves decline when the user declines', async () => {
    const { default: WorkspaceTrustPromptDialog } = await import('./WorkspaceTrustPromptDialog')
    renderToStaticMarkup(<WorkspaceTrustPromptDialog />)

    await getButton("Don't trust").onClick?.()

    expect(mocks.state.modalData.onResolve).toHaveBeenCalledWith('decline')
    expect(mocks.state.closeModal).toHaveBeenCalledTimes(1)
  })
})

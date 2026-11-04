// @vitest-environment happy-dom

// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_FORM, type EditingTarget } from './ssh-target-draft'
import { SshTargetForm } from './SshTargetForm'

afterEach(() => {
  document.body.innerHTML = ''
})

type RenderProps = {
  open?: boolean
  editingId?: string | null
  form?: EditingTarget
  saving?: boolean
  onSave?: () => void
  onOpenChange?: (open: boolean) => void
  onFormChange?: (updater: (prev: EditingTarget) => EditingTarget) => void
}

async function renderForm(props: RenderProps, root?: Root): Promise<Root> {
  const container = root ? null : document.createElement('div')
  if (container) {
    document.body.appendChild(container)
  }
  const nextRoot = root ?? createRoot(container!)
  await act(async () => {
    nextRoot.render(
      <SshTargetForm
        open={props.open ?? true}
        editingId={props.editingId ?? null}
        form={props.form ?? EMPTY_FORM}
        saving={props.saving ?? false}
        onFormChange={props.onFormChange ?? vi.fn()}
        onSave={props.onSave ?? vi.fn()}
        onOpenChange={props.onOpenChange ?? vi.fn()}
      />
    )
  })
  return nextRoot
}

describe('SshTargetForm', () => {
  it('treats a freshly opened edit session as clean', async () => {
    const editTarget: EditingTarget = { ...EMPTY_FORM, label: 'dev-box', host: 'dev-box.lan' }
    const onOpenChange = vi.fn()
    // Start closed so the previous baseline (EMPTY_FORM) differs from the edit draft.
    const root = await renderForm({ open: false, onOpenChange })
    await renderForm({ open: true, editingId: 'target-1', form: editTarget, onOpenChange }, root)

    // Session effects update baseline without rerender; dismissal must read current refs.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await act(async () => {
      document.body.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, cancelable: true })
      )
      document.body.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)
    act(() => root.unmount())
  })

  it('blocks a backdrop dismissal while the draft differs from the baseline', async () => {
    const editTarget: EditingTarget = { ...EMPTY_FORM, label: 'dev-box', host: 'dev-box.lan' }
    const onOpenChange = vi.fn()
    const root = await renderForm({ open: false, onOpenChange })
    await renderForm({ open: true, editingId: 'target-1', form: editTarget, onOpenChange }, root)
    await renderForm(
      {
        open: true,
        editingId: 'target-1',
        form: { ...editTarget, host: 'other.lan' },
        onOpenChange
      },
      root
    )

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await act(async () => {
      document.body.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, cancelable: true })
      )
      document.body.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    expect(onOpenChange).not.toHaveBeenCalled()
    act(() => root.unmount())
  })
})

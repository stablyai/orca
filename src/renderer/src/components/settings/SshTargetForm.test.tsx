// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_FORM, SshTargetForm, type EditingTarget } from './SshTargetForm'

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

function button(label: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === label
  )
  if (!match) {
    throw new Error(`missing ${label} button`)
  }
  return match as HTMLButtonElement
}

describe('SshTargetForm', () => {
  it('opens add mode as a dialog with primary fields in the viewport', async () => {
    const root = await renderForm({})
    expect(document.body.textContent).toContain('Add SSH host')
    expect(document.body.textContent).toContain(
      'Add a persistent machine you can log into over SSH.'
    )
    expect(document.querySelector('#ssh-target-host')).not.toBeNull()
    expect(document.querySelector('#ssh-target-label')).not.toBeNull()
    expect(document.body.textContent).toContain('Add Target')
    expect(document.body.textContent).not.toContain('Editing')
    act(() => root.unmount())
  })

  it('pins header and footer outside the scroll body', async () => {
    const root = await renderForm({})
    const content = document.querySelector('[data-slot="dialog-content"]')
    const header = document.querySelector('[data-slot="dialog-header"]')
    const footer = document.querySelector('[data-slot="dialog-footer"]')
    if (!content || !header || !footer) {
      throw new Error('missing dialog chrome')
    }
    expect(content.className).toContain('overflow-hidden')
    expect(content.className).toContain('flex-col')
    expect(header.className).toContain('shrink-0')
    expect(footer.className).toContain('shrink-0')
    // Why: only the field region scrolls; header/footer stay put when Advanced expands.
    const scrollBody = content.querySelector('.overflow-y-auto')
    expect(scrollBody).not.toBeNull()
    expect(scrollBody?.contains(header)).toBe(false)
    expect(scrollBody?.contains(footer)).toBe(false)
    act(() => root.unmount())
  })

  it('shows edit title and context chip for the target being edited', async () => {
    const root = await renderForm({
      editingId: 'target-1',
      form: {
        ...EMPTY_FORM,
        label: 'dev-box',
        host: 'dev-box.lan',
        username: 'alice',
        port: '2222'
      }
    })
    expect(document.body.textContent).toContain('Edit SSH host')
    expect(document.body.textContent).toContain('Save Changes')
    expect(document.body.textContent).toContain('Editing')
    expect(document.body.textContent).toContain('dev-box')
    expect(document.body.textContent).toContain('alice@dev-box.lan:2222')
    act(() => root.unmount())
  })

  it('submits via the primary action and closes via Cancel', async () => {
    const onSave = vi.fn()
    const onOpenChange = vi.fn()
    const root = await renderForm({ onSave, onOpenChange })

    await act(async () => {
      button('Add Target').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onSave).toHaveBeenCalledOnce()

    await act(async () => {
      button('Cancel').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)
    act(() => root.unmount())
  })

  it('does not render dialog content when closed', async () => {
    const root = await renderForm({ open: false })
    expect(document.querySelector('#ssh-target-host')).toBeNull()
    expect(document.body.textContent).not.toContain('Add SSH host')
    act(() => root.unmount())
  })

  it('collapses Advanced again after cancel and reopen', async () => {
    let form: EditingTarget = EMPTY_FORM
    const onFormChange = vi.fn((updater: (prev: EditingTarget) => EditingTarget) => {
      form = updater(form)
    })
    const root = await renderForm({ form, onFormChange })

    await act(async () => {
      button('Advanced').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(button('Advanced').getAttribute('data-state')).toBe('open')

    await renderForm({ open: false, form, onFormChange }, root)
    await renderForm({ open: true, form: EMPTY_FORM, onFormChange }, root)

    expect(button('Advanced').getAttribute('data-state')).toBe('closed')
    act(() => root.unmount())
  })

  it('blocks a second submit while a save is in flight', async () => {
    const onSave = vi.fn()
    const root = await renderForm({ saving: true, onSave })

    expect(button('Add Target').disabled).toBe(true)
    // Why: Enter submits past a disabled button, so the form itself must gate too.
    await act(async () => {
      document
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    expect(onSave).not.toHaveBeenCalled()
    act(() => root.unmount())
  })

  it('treats a freshly opened edit session as clean', async () => {
    const editTarget: EditingTarget = { ...EMPTY_FORM, label: 'dev-box', host: 'dev-box.lan' }
    const onOpenChange = vi.fn()
    // Start closed so the previous baseline (EMPTY_FORM) differs from the edit draft.
    const root = await renderForm({ open: false, onOpenChange })
    await renderForm({ open: true, editingId: 'target-1', form: editTarget, onOpenChange }, root)

    // Why: the session effect rewrites the baseline without forcing a re-render,
    // so a render-captured isDirty would wrongly block this dismissal.
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

  it('opens Advanced by default when the target already has advanced values', async () => {
    const root = await renderForm({
      editingId: 'target-1',
      form: {
        ...EMPTY_FORM,
        label: 'bastion',
        host: 'bastion.example',
        jumpHost: 'jump.example'
      }
    })
    expect(button('Advanced').getAttribute('data-state')).toBe('open')
    expect(document.body.textContent).toContain('Jump Host')
    act(() => root.unmount())
  })
})

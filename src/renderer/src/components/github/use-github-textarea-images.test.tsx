// @vitest-environment happy-dom
import { StrictMode, useRef, useState } from 'react'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { MentionTextarea } from '@/components/pull-request-page/mentions/textarea'
import { GitHubImageTextarea } from './GitHubImageTextarea'
import { useGitHubImagePending } from './use-github-image-uploads'

const { upload } = vi.hoisted(() => ({ upload: vi.fn() }))
vi.mock('./github-image-upload', () => ({ captureGitHubImageUpload: () => upload }))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
afterEach(cleanup)
function Draft({
  mentions = false,
  initialBody = 'hello ',
  onChange
}: {
  mentions?: boolean
  initialBody?: string
  onChange?: (value: string) => void
}) {
  const [body, setBody] = useState(initialBody)
  const emit = (value: string) => {
    onChange?.(value)
    setBody(value)
  }
  const images = useGitHubImagePending()
  const ref = useRef<HTMLTextAreaElement>(null)
  const imageUpload = {
    address: {
      runtime: { kind: 'local' as const },
      target: {
        kind: 'repo' as const,
        repo: 'repo',
        source: 'origin' as const
      }
    },
    onPending: images.onPending
  }
  return (
    <>
      {mentions ? (
        <MentionTextarea
          value={body}
          onValueChange={emit}
          textareaRef={ref}
          placeholder="Draft"
          rows={3}
          imageUpload={imageUpload}
          mentionOptions={[
            { login: 'octocat', name: 'Octocat', avatarUrl: '', source: 'participant' }
          ]}
        />
      ) : (
        <GitHubImageTextarea
          value={body}
          onValueChange={emit}
          imageUpload={imageUpload}
          aria-label="Draft"
        />
      )}
      <output>{body}</output>
      <button disabled={images.pending}>Submit</button>
      <button onClick={() => setBody('Replacement')}>Replace</button>
    </>
  )
}
function textareaField(element: HTMLElement): HTMLTextAreaElement {
  if (!(element instanceof HTMLTextAreaElement)) {
    throw new Error('Draft field must be a textarea')
  }
  return element
}
function paste(textarea: HTMLTextAreaElement) {
  textarea.setSelectionRange(textarea.value.length, textarea.value.length)
  fireEvent.paste(textarea, {
    clipboardData: { files: [new File(['png'], 'screen.png', { type: 'image/png' })] }
  })
}
it('keeps mentions aligned with display text and emits only a completed URL', async () => {
  const held = Promise.withResolvers<string>()
  upload.mockReset().mockReturnValue(held.promise)
  const view = render(<Draft mentions />)
  const field = textareaField(view.getByRole('combobox'))
  paste(field)
  expect(field.value).toContain('Uploading screen.png')
  expect(view.container.querySelector('output')?.textContent).toBe('hello ')
  expect(view.getByRole('button', { name: 'Submit' }).hasAttribute('disabled')).toBe(true)
  fireEvent.change(field, { target: { value: `${field.value} @oct` } })
  fireEvent.keyUp(field, { key: 't' })
  fireEvent.keyDown(field, { key: 'Enter' })
  await act(async () => held.resolve('https://github.com/user-attachments/assets/screen'))
  await waitFor(() => expect(field.value).not.toContain('Uploading'))
  expect(view.container.querySelector('output')?.textContent).toBe(
    'hello ![screen.png](<https://github.com/user-attachments/assets/screen>) @octocat'
  )
})
it('removes an entire partly deleted marker and never restores it on completion', async () => {
  const held = Promise.withResolvers<string>()
  upload.mockReset().mockReturnValue(held.promise)
  const view = render(<Draft />)
  const field = textareaField(view.getByRole('textbox'))
  paste(field)
  fireEvent.change(field, { target: { value: field.value.slice(0, -1) } })
  expect(field.value).toBe('hello ')
  expect(view.container.querySelector('output')?.textContent).toBe('hello ')
  await act(async () => held.resolve('https://github.com/user-attachments/assets/deleted'))
  expect(field.value).toBe('hello ')
})
it('delivers a File drop through the registered owner and detaches an externally replaced draft', async () => {
  const held = Promise.withResolvers<string>()
  upload.mockReset().mockReturnValue(held.promise)
  const view = render(<Draft />)
  const field = textareaField(view.getByRole('textbox'))
  const drop = new Event('drop', { bubbles: true, cancelable: true, composed: true })
  Object.defineProperties(drop, {
    isTrusted: { value: true },
    dataTransfer: {
      value: {
        types: ['Files'],
        files: [new File(['png'], 'drop.png', { type: 'image/png' })]
      }
    }
  })
  act(() => {
    field.dispatchEvent(drop)
  })
  expect(field.value).toContain('Uploading drop.png')
  fireEvent.click(view.getByRole('button', { name: 'Replace' }))
  await act(async () => held.resolve('https://github.com/user-attachments/assets/orphan'))
  expect(field.value).toBe('Replacement')
  expect(view.container.querySelector('output')?.textContent).toBe('Replacement')
})

it('removes an undo-restored owned label after an incomplete user label prefix', async () => {
  const held = Promise.withResolvers<string>()
  upload.mockReset().mockReturnValue(held.promise)
  const prefix = '![Uploading note '
  const view = render(<Draft initialBody={prefix} />)
  const field = textareaField(view.getByRole('textbox'))
  paste(field)
  const restored = field.value
  fireEvent.change(field, { target: { value: field.value.slice(0, -1) } })
  expect(field.value).toBe(prefix)
  fireEvent.change(field, { target: { value: restored } })
  expect(field.value).toBe(prefix)
  expect(view.container.querySelector('output')?.textContent).toBe(prefix)
  await act(async () => held.resolve('https://github.com/user-attachments/assets/deleted'))
  expect(view.container.querySelector('output')?.textContent).toBe(prefix)
})

it.each([10, 100])(
  'retires the active upload and %i queued files without reviving them',
  async (count) => {
    let active: AbortSignal | undefined
    upload.mockReset().mockImplementation((_file: File, signal: AbortSignal) => {
      active = signal
      return new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      )
    })
    const onChange = vi.fn()
    const view = render(
      <StrictMode>
        <Draft onChange={onChange} />
      </StrictMode>
    )
    fireEvent.paste(view.getByRole('textbox'), {
      clipboardData: {
        files: Array.from(
          { length: count },
          () => new File(['png'], 'image.png', { type: 'image/png' })
        )
      }
    })
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1))
    const changes = onChange.mock.calls.length
    await act(async () => view.unmount())
    expect(active?.aborted).toBe(true)
    expect(upload).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledTimes(changes)
    upload.mockResolvedValue('https://github.com/user-attachments/assets/live')
    const successor = render(
      <StrictMode>
        <Draft />
      </StrictMode>
    )
    paste(textareaField(successor.getByRole('textbox')))
    await waitFor(() =>
      expect(successor.container.querySelector('output')?.textContent).toContain('assets/live')
    )
    expect(upload).toHaveBeenCalledTimes(2)
  }
)

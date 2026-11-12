// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { Profiler, StrictMode } from 'react'
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { DiffCommentCard } from './DiffCommentCard'
import { DiffCommentFileSession, type DiffCommentDraftSession } from './diff-comment-session'
import {
  DiffCommentSessionScope,
  useDiffCommentFileSession,
  useDiffCommentSessionRegistry
} from './diff-comment-session-registry'

vi.mock('../editor/review-note-delivery/NotesSendMenu', () => ({ NotesSendMenu: () => null }))

afterEach(async () => {
  cleanup()
  observedSessions.clear()
  document.body.replaceChildren()
  await act(async () => {})
})

function deferred() {
  let resolve!: (saved: boolean) => void
  const promise = new Promise<boolean>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const observedSessions = new Map<string, DiffCommentFileSession>()

const saveNote = async (): Promise<boolean> => true

function Note({
  id = 'note',
  save = saveNote
}: {
  id?: string
  save?: (body: string) => Promise<boolean>
}) {
  const session = useDiffCommentFileSession(id)
  if (session) {
    observedSessions.set(id, session)
  }
  return (
    <DiffCommentCard
      lineNumber={5}
      body="Saved text"
      commentId={id}
      session={session}
      onSubmitEdit={save}
    />
  )
}

it('keeps accepted saved-note edits across whole row/gate detach without stealing focus, and retires known deletion', async () => {
  const request = deferred()
  const save = vi.fn(() => request.promise)
  const other = document.createElement('input')
  document.body.append(other)
  const tree = (shown: boolean, knownNoteIds?: ReadonlySet<string>) => (
    <StrictMode>
      <DiffCommentSessionScope scope="copy-a" knownNoteIds={knownNoteIds}>
        {shown && <Note save={save} />}
      </DiffCommentSessionScope>
    </StrictMode>
  )
  const view = render(tree(true))
  fireEvent.click(view.getByTitle('Edit note'))
  fireEvent.change(within(view.container).getByRole('textbox'), {
    target: { value: 'Distinct unsaved text' }
  })
  other.focus()
  view.rerender(tree(false))
  await act(async () => {})
  view.rerender(tree(true))
  expect(within(view.container).getByRole('textbox')).toHaveValue('Distinct unsaved text')
  expect(document.activeElement).toBe(other)
  fireEvent.click(view.getByRole('button', { name: 'Save' }))
  expect(save).toHaveBeenCalledWith('Distinct unsaved text')
  fireEvent.change(within(view.container).getByRole('textbox'), {
    target: { value: 'Text accepted after submit' }
  })
  view.rerender(tree(false))
  await act(async () => request.resolve(true))
  view.rerender(tree(true))
  expect(within(view.container).getByRole('textbox')).toHaveValue('Text accepted after submit')
  expect(document.activeElement).toBe(other)
  view.rerender(tree(false, new Set()))
  view.rerender(tree(true, new Set()))
  expect(within(view.container).queryByRole('textbox')).toBeNull()
  fireEvent.click(view.getByTitle('Edit note'))
  expect(within(view.container).getByRole('textbox')).toHaveValue('Saved text')
  fireEvent.click(view.getByRole('button', { name: 'Cancel' }))
  view.rerender(tree(false))
  view.rerender(tree(true))
  expect(within(view.container).queryByRole('textbox')).toBeNull()
  other.remove()
})

it('preserves unknown inventory but revokes a positively replaced copy and its issued retry', async () => {
  const request = deferred()
  function CloseFiles() {
    const registry = useDiffCommentSessionRegistry()
    return <button onClick={() => registry?.clear()}>Conversation</button>
  }
  const tree = (scope: string, shown = true) => (
    <DiffCommentSessionScope scope={scope}>
      <CloseFiles />
      {shown && <Note save={() => request.promise} />}
    </DiffCommentSessionScope>
  )
  const view = render(tree('copy-a'))
  const textbox = () => within(view.container).getByRole('textbox')
  fireEvent.click(view.getByTitle('Edit note'))
  fireEvent.change(textbox(), { target: { value: 'Copy A draft' } })
  view.rerender(tree('copy-a', false))
  await act(async () => {})
  view.rerender(tree('copy-a'))
  expect(textbox()).toHaveValue('Copy A draft')
  fireEvent.click(view.getByRole('button', { name: 'Save' }))
  view.rerender(tree('copy-b'))
  expect(within(view.container).queryByRole('textbox')).toBeNull()
  fireEvent.click(view.getByTitle('Edit note'))
  fireEvent.change(textbox(), { target: { value: 'Copy B draft' } })
  view.rerender(tree('copy-a'))
  expect(within(view.container).queryByRole('textbox')).toBeNull()
  await act(async () => request.resolve(false))
  expect(within(view.container).queryByRole('textbox')).toBeNull()
  fireEvent.click(view.getByTitle('Edit note'))
  expect(textbox()).toHaveValue('Saved text')
  view.rerender(tree('copy-a', false))
  fireEvent.click(view.getByText('Conversation'))
  view.rerender(tree('copy-a'))
  expect(within(view.container).queryByRole('textbox')).toBeNull()
})

it.each([10, 100])(
  'updates only the edited consumer among %i real note cards and another copy',
  (count) => {
    const rendered = Array.from({ length: count }, () => vi.fn())
    const foreignRender = vi.fn()
    const view = render(
      <>
        <DiffCommentSessionScope>
          {rendered.map((onRender, index) => (
            <Profiler id={String(index)} key={index} onRender={onRender}>
              <div data-testid={`note-${index}`}>
                <Note id={`note-${index}`} />
              </div>
            </Profiler>
          ))}
        </DiffCommentSessionScope>
        <DiffCommentSessionScope scope="other-copy">
          <Profiler id="other-copy" onRender={foreignRender}>
            <div data-testid="other-copy">
              <Note id="other-copy" />
            </div>
          </Profiler>
        </DiffCommentSessionScope>
      </>
    )
    const membership = vi.fn()
    const cleanups = [...observedSessions.entries()].map(([id, session]) =>
      session.subscribeEdit(id, membership)
    )
    const foreign = within(view.getByTestId('other-copy'))
    fireEvent.click(foreign.getByTitle('Edit note'))
    fireEvent.change(foreign.getByRole('textbox'), { target: { value: 'Other copy text' } })
    const foreignNotice = vi.fn()
    const stopForeign = observedSessions
      .get('other-copy')!
      .getEdit('other-copy')!
      .subscribe(foreignNotice)
    const target = within(view.getByTestId('note-0'))
    fireEvent.click(target.getByTitle('Edit note'))
    const bodyNotice = vi.fn()
    const stopBody = observedSessions.get('note-0')!.getEdit('note-0')!.subscribe(bodyNotice)
    membership.mockClear()
    foreignRender.mockClear()
    for (const onRender of rendered) {
      onRender.mockClear()
    }
    fireEvent.change(target.getByRole('textbox'), { target: { value: 'One accepted edit' } })
    expect(target.getByRole('textbox')).toHaveValue('One accepted edit')
    expect(foreign.getByRole('textbox')).toHaveValue('Other copy text')
    expect(bodyNotice).toHaveBeenCalledTimes(1)
    expect(membership).not.toHaveBeenCalled()
    expect(foreignNotice).not.toHaveBeenCalled()
    for (const stop of cleanups) {
      stop()
    }
    stopBody()
    stopForeign()
    expect(rendered[0]).toHaveBeenCalledTimes(1)
    expect(rendered.slice(1).every((onRender) => onRender.mock.calls.length === 0)).toBe(true)
    expect(foreignRender).not.toHaveBeenCalled()
  }
)

it.each([
  'success-with-b',
  'failure-with-b',
  'failure-after-b-cancel',
  'failure-detached',
  'disposed'
] as const)('settles an issued draft by exact session: %s', async (outcome) => {
  const file = new DiffCommentFileSession()
  const request = deferred()
  const a = file.openDraft({ lineNumber: 5 }, async () => request.promise)!
  a.setBody('Draft A')
  const pending = file.submitDraft(a, () => request.promise, 'Draft A')
  let b: DiffCommentDraftSession | null = null
  if (outcome.includes('b')) {
    b = file.openDraft({ lineNumber: 9 }, async () => true)!
    b.setBody('Draft B')
    if (outcome === 'failure-after-b-cancel') {
      file.cancelDraft(b)
    }
  }
  if (outcome === 'disposed') {
    file.dispose()
  }
  request.resolve(outcome === 'success-with-b')
  await pending
  if (outcome === 'disposed') {
    expect(file.getDraft()).toBeNull()
  } else if (outcome === 'success-with-b' || outcome === 'failure-with-b') {
    expect(file.getDraft()?.getSnapshot().body).toBe('Draft B')
    expect(file.getDraft()?.target.lineNumber).toBe(9)
    file.cancelDraft(b!)
    expect(file.getDraft()).toBeNull()
  } else {
    expect(file.getDraft()?.getSnapshot()).toEqual({ body: 'Draft A', phase: 'editing' })
    expect(file.getDraft()?.target.lineNumber).toBe(5)
  }
})

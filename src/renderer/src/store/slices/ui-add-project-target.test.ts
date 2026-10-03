import { describe, expect, it } from 'vitest'
import { createUIStore } from './ui-slice-test-harness'

const TARGET = { groupId: 'group-1', hostId: 'local' }

describe('createUISlice addProjectTarget', () => {
  it('starts with no target', () => {
    expect(createUIStore().getState().addProjectTarget).toBeNull()
  })

  it('stores the group and host when add-repo opens with a target', () => {
    const store = createUIStore()

    store.getState().openModal('add-repo', { addProjectTarget: TARGET })

    expect(store.getState().addProjectTarget).toEqual(TARGET)
  })

  it('clears the target when the flow ends', () => {
    const store = createUIStore()
    store.getState().openModal('add-repo', { addProjectTarget: TARGET })

    store.getState().closeModal()

    expect(store.getState().addProjectTarget).toBeNull()
  })

  it('clears a stale target when add-repo opens without one', () => {
    const store = createUIStore()
    store.getState().openModal('add-repo', { addProjectTarget: TARGET })

    store.getState().openModal('add-repo')

    expect(store.getState().addProjectTarget).toBeNull()
  })

  // Why: a non-git path closes add-repo and opens the confirm dialog, so that step
  // re-declares the target rather than inheriting it.
  it('accepts the target re-declared by a handoff step', () => {
    const store = createUIStore()
    store.getState().openModal('add-repo', { addProjectTarget: TARGET })

    store.getState().closeModal()
    store
      .getState()
      .openModal('confirm-non-git-folder', { folderPath: '/tmp/x', addProjectTarget: TARGET })

    expect(store.getState().addProjectTarget).toEqual(TARGET)
  })

  // Why: the file explorer opens this dialog on its own; it must not inherit a group
  // the user picked for an earlier, unrelated add.
  it('does not let an unrelated add inherit a target', () => {
    const store = createUIStore()
    store.getState().openModal('add-repo', { addProjectTarget: TARGET })

    store.getState().openModal('confirm-add-project-from-folder', { folderPath: '/tmp/y' })

    expect(store.getState().addProjectTarget).toBeNull()
  })

  // Why: switching to an unrelated modal without closing first ends the add flow just the same,
  // and the composer hosts its own Add Project dialog that would otherwise consume the target.
  it('drops the target when a modal outside the add flow opens', () => {
    const store = createUIStore()
    store.getState().openModal('add-repo', { addProjectTarget: TARGET })

    store.getState().openModal('new-workspace-composer', { addProjectTarget: TARGET })

    expect(store.getState().addProjectTarget).toBeNull()
  })

  it.each([
    ['a missing host', { groupId: 'group-1' }],
    ['a missing group', { hostId: 'local' }],
    ['an empty group id', { groupId: '', hostId: 'local' }],
    ['a non-object', 'group-1']
  ])('rejects %s', (_label, addProjectTarget) => {
    const store = createUIStore()

    store.getState().openModal('add-repo', { addProjectTarget })

    expect(store.getState().addProjectTarget).toBeNull()
  })

  it('is cleared by clearAddProjectTarget so one flow assigns one project', () => {
    const store = createUIStore()
    store.getState().openModal('add-repo', { addProjectTarget: TARGET })

    store.getState().clearAddProjectTarget()

    expect(store.getState().addProjectTarget).toBeNull()
  })
})

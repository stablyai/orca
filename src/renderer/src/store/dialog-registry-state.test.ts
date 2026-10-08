import { describe, expect, it } from 'vitest'
import {
  AUTOMATIC_DIALOG_ORDER,
  closeDialogEntry,
  dialogContentMounted,
  dialogContentUnmounted,
  endDialogEntry,
  enqueueAutomaticDialog,
  INITIAL_DIALOG_REGISTRY,
  openDialogEntry,
  selectDialogPhase,
  selectTourBlocked,
  selectTourParentToken,
  selectDialogOnScreen,
  selectTourInterrupted,
  settleStartupSource,
  type AutomaticDialogKind,
  type DialogRegistry
} from './dialog-registry-state'

const settled: DialogRegistry = {
  ...INITIAL_DIALOG_REGISTRY,
  startupSources: { 'crash-report': 'none', 'feature-tip': 'none', 'native-chat-resume': 'none' }
}

function phase(registry: DialogRegistry, token: string): string | null {
  return selectDialogPhase(registry, token)
}

/** What the dialog's content does: mounts once admitted, unmounts once closed. */
function show(registry: DialogRegistry, token: string): DialogRegistry {
  return dialogContentMounted(registry, token)
}

function dismiss(registry: DialogRegistry, token: string): DialogRegistry {
  return dialogContentUnmounted(closeDialogEntry(registry, token), token)
}

describe('self-opening dialogs take turns', () => {
  const pairs = AUTOMATIC_DIALOG_ORDER.flatMap((first, i) =>
    AUTOMATIC_DIALOG_ORDER.slice(i + 1).map((second) => [first, second] as const)
  )

  it.each(pairs)('%s goes before %s, whichever was queued first', (first, second) => {
    let registry = enqueueAutomaticDialog(settled, 'later', second)
    // The later kind took the turn at once: nothing else was waiting.
    expect(phase(registry, 'later')).toBe('opening')
    registry = dismiss(show(registry, 'later'), 'later')

    // Both queued while a dialog is up: the earlier kind is admitted next, not the earlier arrival.
    registry = dialogContentMounted(registry, 'user')
    registry = enqueueAutomaticDialog(registry, 'b', second)
    registry = enqueueAutomaticDialog(registry, 'a', first)
    expect(phase(registry, 'b')).toBe('queued')
    registry = dialogContentUnmounted(registry, 'user')
    expect(phase(registry, 'a')).toBe('opening')
    expect(phase(registry, 'b')).toBe('queued')
    registry = dismiss(show(registry, 'a'), 'a')
    expect(phase(registry, 'b')).toBe('opening')
  })

  it.each(pairs)('%s goes before %s even when the later check answers first', (first, second) => {
    let registry: DialogRegistry = {
      ...INITIAL_DIALOG_REGISTRY,
      startupSources: { ...settled.startupSources, [first]: 'pending' }
    }
    registry = settleStartupSource(registry, second, 'ready', 'b')
    expect(phase(registry, 'b')).toBe('queued')
    // The earlier check answers with its own dialog, which goes first.
    registry = settleStartupSource(registry, first, 'ready', 'a')
    expect(phase(registry, 'a')).toBe('opening')
    expect(phase(registry, 'b')).toBe('queued')
  })

  it.each(['none', 'unavailable'] as const)(
    'an earlier check answering %s lets the later kind show',
    (answer) => {
      let registry = settleStartupSource(INITIAL_DIALOG_REGISTRY, 'native-chat-resume', 'ready')
      registry = enqueueAutomaticDialog(registry, 'resume', 'native-chat-resume')
      registry = settleStartupSource(registry, 'crash-report', answer)
      expect(phase(registry, 'resume')).toBe('queued')
      registry = settleStartupSource(registry, 'feature-tip', answer)
      expect(phase(registry, 'resume')).toBe('opening')
    }
  )

  it('a crash report never waits for a startup check', () => {
    const registry = enqueueAutomaticDialog(INITIAL_DIALOG_REGISTRY, 'crash', 'crash-report')
    expect(phase(registry, 'crash')).toBe('opening')
  })

  it('a check answers once; its item is queued in the same step', () => {
    let registry = settleStartupSource(INITIAL_DIALOG_REGISTRY, 'crash-report', 'ready', 'crash')
    expect(registry.startupSources['crash-report']).toBe('ready')
    expect(phase(registry, 'crash')).toBe('opening')
    registry = settleStartupSource(registry, 'crash-report', 'unavailable')
    expect(registry.startupSources['crash-report']).toBe('ready')
  })

  it('queues each item of a kind in arrival order; the same token is one item', () => {
    let registry = dialogContentMounted(settled, 'user')
    registry = enqueueAutomaticDialog(registry, 'crash:1', 'crash-report')
    registry = enqueueAutomaticDialog(registry, 'crash:2', 'crash-report')
    registry = enqueueAutomaticDialog(registry, 'crash:1', 'crash-report')
    expect(registry.dialogEntries.filter((entry) => entry.kind === 'crash-report')).toHaveLength(2)
    registry = dialogContentUnmounted(registry, 'user')
    expect(phase(registry, 'crash:1')).toBe('opening')
    registry = dismiss(show(registry, 'crash:1'), 'crash:1')
    // The second report is its own dialog; the first never replaced it.
    expect(phase(registry, 'crash:2')).toBe('opening')
  })
})

describe('dialogs opened over a self-opening one', () => {
  it.each(AUTOMATIC_DIALOG_ORDER)(
    'a user dialog stacks over a shown %s, which stays; the next waits for both',
    (kind: AutomaticDialogKind) => {
      let registry = enqueueAutomaticDialog(settled, 'shown', kind)
      registry = show(registry, 'shown')
      registry = enqueueAutomaticDialog(registry, 'next', 'native-chat-resume')
      registry = show(dialogContentMounted(registry, 'user'), 'user')
      expect(phase(registry, 'shown')).toBe('visible')
      expect(phase(registry, 'user')).toBe('visible')
      registry = dismiss(registry, 'user')
      expect(phase(registry, 'shown')).toBe('visible')
      expect(phase(registry, 'next')).toBe('queued')
      registry = dismiss(registry, 'shown')
      expect(phase(registry, 'next')).toBe('opening')
    }
  )

  it('a response dialog opens at once, even before every check has answered', () => {
    let registry = show(
      enqueueAutomaticDialog(INITIAL_DIALOG_REGISTRY, 'crash', 'crash-report'),
      'crash'
    )
    registry = openDialogEntry(registry, {
      token: 'ssh',
      kind: 'ssh-credential',
      origin: 'response'
    })
    expect(phase(registry, 'ssh')).toBe('opening')
    expect(phase(registry, 'crash')).toBe('visible')
  })

  it.each(['user', 'response'] as const)(
    'a %s dialog opened while an admitted one has not painted yet sends it back to its place',
    (origin) => {
      let registry = enqueueAutomaticDialog(settled, 'crash', 'crash-report')
      const tokens = registry.dialogEntries.map((entry) => entry.token)
      expect(phase(registry, 'crash')).toBe('opening')
      registry = dialogContentMounted(registry, 'top', 'dialog', origin)
      // Its code was still loading: it waits under nothing, and the dialog opened now stays on top.
      expect(registry.dialogEntries.find((entry) => entry.token === 'crash')).toEqual(
        expect.objectContaining({ phase: 'queued' })
      )
      expect(
        registry.dialogEntries
          .filter((entry) => tokens.includes(entry.token))
          .map((entry) => entry.token)
      ).toEqual(tokens)
      registry = dismiss(show(registry, 'top'), 'top')
      expect(phase(registry, 'crash')).toBe('opening')
    }
  )

  it('an earlier kind queued before the admitted one painted goes first', () => {
    let registry = enqueueAutomaticDialog(settled, 'resume', 'native-chat-resume')
    expect(phase(registry, 'resume')).toBe('opening')
    registry = enqueueAutomaticDialog(registry, 'tip', 'feature-tip')
    expect(phase(registry, 'tip')).toBe('opening')
    expect(phase(registry, 'resume')).toBe('queued')
    // Once painted it keeps its turn.
    registry = enqueueAutomaticDialog(show(registry, 'tip'), 'crash', 'crash-report')
    expect(phase(registry, 'tip')).toBe('visible')
    expect(phase(registry, 'crash')).toBe('queued')
  })

  it('the next is admitted only once the previous one finished closing', () => {
    let registry = show(enqueueAutomaticDialog(settled, 'crash', 'crash-report'), 'crash')
    registry = enqueueAutomaticDialog(registry, 'tip', 'feature-tip')
    registry = closeDialogEntry(registry, 'crash')
    // Its exit animation is still on screen.
    expect(phase(registry, 'crash')).toBe('closing')
    expect(phase(registry, 'tip')).toBe('queued')
    registry = dialogContentUnmounted(registry, 'crash')
    expect(phase(registry, 'crash')).toBeNull()
    expect(phase(registry, 'tip')).toBe('opening')
  })

  it('a dialog reopened while closing is back on screen, not a second entry', () => {
    let registry = show(
      openDialogEntry(settled, { token: 'd', kind: 'dialog', origin: 'user' }),
      'd'
    )
    registry = closeDialogEntry(registry, 'd')
    registry = openDialogEntry(registry, { token: 'd', kind: 'dialog', origin: 'user' })
    expect(registry.dialogEntries).toEqual([expect.objectContaining({ phase: 'visible' })])
  })

  it('a failed surface ends only its own entry', () => {
    let registry = dialogContentMounted(settled, 'a')
    registry = dialogContentMounted(registry, 'b')
    registry = enqueueAutomaticDialog(registry, 'crash', 'crash-report')
    registry = endDialogEntry(registry, 'a')
    expect(phase(registry, 'a')).toBeNull()
    expect(phase(registry, 'b')).toBe('visible')
    expect(phase(registry, 'crash')).toBe('queued')
  })

  it('withdrawing a queued one gives its place to the next', () => {
    let registry = dialogContentMounted(settled, 'user')
    registry = enqueueAutomaticDialog(registry, 'crash', 'crash-report')
    registry = enqueueAutomaticDialog(registry, 'tip', 'feature-tip')
    registry = closeDialogEntry(registry, 'crash')
    registry = dialogContentUnmounted(registry, 'user')
    expect(phase(registry, 'crash')).toBeNull()
    expect(phase(registry, 'tip')).toBe('opening')
  })

  it('the user opening a queued one opens it at once, in place', () => {
    let registry = show(enqueueAutomaticDialog(settled, 'crash', 'crash-report'), 'crash')
    registry = enqueueAutomaticDialog(registry, 'resume', 'native-chat-resume')
    registry = openDialogEntry(registry, {
      token: 'resume',
      kind: 'native-chat-resume',
      origin: 'user'
    })
    expect(registry.dialogEntries.filter((entry) => entry.token === 'resume')).toEqual([
      expect.objectContaining({ origin: 'user', phase: 'opening' })
    ])
    // A later launch request for it is the same entry.
    registry = enqueueAutomaticDialog(registry, 'resume', 'native-chat-resume')
    expect(registry.dialogEntries.filter((entry) => entry.token === 'resume')).toHaveLength(1)
  })
})

describe('tours', () => {
  it('one started by the app goes after every startup check and self-opening dialog', () => {
    expect(selectTourBlocked(INITIAL_DIALOG_REGISTRY, false)).toBe(true)
    expect(selectTourBlocked(settled, false)).toBe(false)
    const queued = enqueueAutomaticDialog(dialogContentMounted(settled, 'u'), 'tip', 'feature-tip')
    expect(selectTourBlocked(dialogContentUnmounted(queued, 'u'), false)).toBe(true)
  })

  it('one the user asked for yields only to what is on screen', () => {
    expect(selectTourBlocked(INITIAL_DIALOG_REGISTRY, true)).toBe(false)
    const user = dialogContentMounted(settled, 'u')
    expect(selectTourBlocked(user, true)).toBe(true)
    expect(selectTourInterrupted(user)).toBe(true)
  })

  it('runs inside the modal it is written for, but not inside a dialog opened from it', () => {
    let registry = dialogContentMounted(settled, 'composer', 'new-workspace-composer')
    const parent = selectTourParentToken(registry, ['new-workspace-composer'])
    expect(parent).toBe('composer')
    expect(selectTourBlocked(registry, true, parent)).toBe(false)
    expect(selectTourBlocked(registry, true)).toBe(true)
    registry = dialogContentMounted(registry, 'nested')
    expect(selectTourInterrupted(registry, parent)).toBe(true)
  })

  it('a running tour holds self-opening dialogs back until it ends', () => {
    let registry = dialogContentMounted(settled, 'tour:browser', 'tour', 'tour')
    registry = enqueueAutomaticDialog(registry, 'crash', 'crash-report')
    expect(phase(registry, 'crash')).toBe('queued')
    // The tour itself never counts as something a tour must give way to.
    expect(selectTourInterrupted(registry)).toBe(false)
    registry = dialogContentUnmounted(registry, 'tour:browser')
    expect(phase(registry, 'crash')).toBe('opening')
  })
})

it('user opening intent and an empty host count nothing; committed content alone blocks admission', () => {
  let registry = openDialogEntry(settled, { token: 'user', kind: 'dialog', origin: 'user' })
  expect(selectDialogOnScreen(registry)).toBe(false)
  registry = enqueueAutomaticDialog(registry, 'crash', 'crash-report')
  expect(phase(registry, 'crash')).toBe('opening')
  registry = dialogContentMounted(registry, 'user')
  expect(selectDialogOnScreen(registry)).toBe(true)
  expect(phase(registry, 'crash')).toBe('queued')
  registry = dialogContentUnmounted(registry, 'user')
  expect(phase(registry, 'crash')).toBe('opening')
})

it('a stale content commit cannot acknowledge an automatic dialog returned to its queue', () => {
  let registry = enqueueAutomaticDialog(settled, 'crash', 'crash-report')
  registry = dialogContentMounted(registry, 'user')
  registry = dialogContentMounted(registry, 'crash')
  expect(phase(registry, 'crash')).toBe('queued')
})

it('composer allowance comes only from its mounted content, and closes with it', () => {
  let registry = openDialogEntry(settled, {
    token: 'composer',
    kind: 'new-workspace-composer',
    origin: 'user'
  })
  expect(selectTourParentToken(registry, ['new-workspace-composer'])).toBeNull()
  registry = dialogContentMounted(registry, 'composer')
  expect(selectTourParentToken(registry, ['new-workspace-composer'])).toBe('composer')
  registry = closeDialogEntry(registry, 'composer')
  expect(selectTourParentToken(registry, ['new-workspace-composer'])).toBeNull()
  expect(selectTourBlocked(registry, true)).toBe(true)
})

it('onboarding content blocks automatic prompts and forced tours, without a separate visibility flag', () => {
  let registry = dialogContentMounted(settled, 'onboarding', 'onboarding')
  registry = enqueueAutomaticDialog(registry, 'crash', 'crash-report')
  expect(phase(registry, 'crash')).toBe('queued')
  expect(selectTourBlocked(registry, true)).toBe(true)
  registry = dialogContentUnmounted(registry, 'onboarding')
  expect(phase(registry, 'crash')).toBe('opening')
})

import { describe, expect, it } from 'vitest'
import { resolveTabAgentFromSignals } from './tab-agent-from-signals'

// OMP wraps Pi and emits compatible titles; preserve each pane’s own identity even when mirror/restore loses host launch metadata.
describe('resolveTabAgentFromSignals — Pi/OMP identity', () => {
  it('keeps OMP launch identity over Pi-compatible wrapper titles after activity', () => {
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: true,
        isRemote: true,
        title: '⠋ Pi',
        hookAgent: null,
        launchAgent: 'omp'
      })
    ).toBe('omp')

    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: true,
        isRemote: true,
        title: '⠋ Pi',
        hookAgent: 'pi',
        launchAgent: 'omp'
      })
    ).toBe('omp')

    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: true,
        isRemote: false,
        title: '⠋ Pi',
        hookAgent: 'pi',
        launchAgent: 'omp'
      })
    ).toBe('omp')

    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: true,
        isRemote: true,
        title: 'Terminal 1',
        hookAgent: null,
        siblingHookAgent: 'pi',
        launchAgent: 'omp'
      })
    ).toBe('omp')

    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: true,
        isRemote: true,
        title: '⠋ OMP',
        hookAgent: 'omp',
        launchAgent: 'pi'
      })
    ).toBe('pi')

    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: true,
        isRemote: true,
        title: 'zsh',
        hookAgent: null,
        focusedCompletedHookAgent: 'pi',
        launchAgent: 'omp'
      })
    ).toBe('omp')

    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: true,
        isRemote: false,
        title: 'zsh',
        hookAgent: null,
        siblingCompletedHookAgent: 'pi',
        launchAgent: 'omp'
      })
    ).toBe('omp')
  })

  it('keeps a restored/mirrored OMP pane on OMP when launchAgent is gone', () => {
    // After launchAgent loss, completed-hook/session ownership must anchor OMP wrapper titles instead of flipping to Pi.
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: true,
        isRemote: true,
        title: '⠋ Pi',
        hookAgent: null,
        focusedCompletedHookAgent: 'omp',
        launchAgent: undefined
      })
    ).toBe('omp')

    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: true,
        isRemote: true,
        title: '⠋ Pi',
        hookAgent: null,
        sleepingSessionAgent: 'omp',
        launchAgent: undefined
      })
    ).toBe('omp')
  })

  it('does not flap between OMP and Pi as a launchAgent-less pane cycles hooks', () => {
    const withLiveHook = resolveTabAgentFromSignals({
      hasObservedAgentSignal: true,
      isRemote: true,
      title: '⠋ Pi',
      hookAgent: 'omp',
      focusedCompletedHookAgent: 'omp',
      launchAgent: undefined
    })
    const afterHookCleared = resolveTabAgentFromSignals({
      hasObservedAgentSignal: true,
      isRemote: true,
      title: '⠋ Pi',
      hookAgent: null,
      focusedCompletedHookAgent: 'omp',
      launchAgent: undefined
    })
    expect(withLiveHook).toBe('omp')
    expect(afterHookCleared).toBe('omp')
  })

  it('does not flap between OMP and Pi as the foreground process oscillates', () => {
    // OMP’s nested pi alternates foreground reads at command boundaries; normalize both to the known OMP owner instead of flickering icons.
    const readsPi = resolveTabAgentFromSignals({
      hasObservedAgentSignal: true,
      isRemote: false,
      title: '⠋ OMP',
      hookAgent: null,
      processAgent: 'pi',
      launchAgent: 'omp'
    })
    const readsOmp = resolveTabAgentFromSignals({
      hasObservedAgentSignal: true,
      isRemote: false,
      title: '⠋ OMP',
      hookAgent: null,
      processAgent: 'omp',
      launchAgent: 'omp'
    })
    expect(readsPi).toBe('omp')
    expect(readsOmp).toBe('omp')
  })

  it('re-owns a Pi foreground read to a durable OMP identity when launchAgent is gone', () => {
    // Completed-hook ownership must keep nested pi foreground reads on OMP after mirror/restore.
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: true,
        isRemote: false,
        title: '⠋ OMP',
        hookAgent: null,
        focusedCompletedHookAgent: 'omp',
        processAgent: 'pi',
        launchAgent: undefined
      })
    ).toBe('omp')
  })

  it('still lets a genuine cross-group foreground process reclaim a reused OMP pane', () => {
    // Different-group processes prove actual reuse and must override launch ownership.
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: true,
        isRemote: false,
        title: 'zsh',
        hookAgent: null,
        processAgent: 'codex',
        launchAgent: 'omp'
      })
    ).toBe('codex')
  })

  it('keeps a launchAgent-less Pi pane on Pi and rejects a stale OMP session record', () => {
    // Fresh Pi hook ownership must beat stale sleeping OMP evidence.
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: true,
        isRemote: true,
        title: '⠋ Pi',
        hookAgent: null,
        focusedCompletedHookAgent: 'pi',
        sleepingSessionAgent: 'omp',
        launchAgent: undefined
      })
    ).toBe('pi')

    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: true,
        isRemote: true,
        title: '⠋ OMP',
        hookAgent: null,
        focusedCompletedHookAgent: 'pi',
        launchAgent: undefined
      })
    ).toBe('pi')
  })
})

// Hook records identify panes across working/done turns; title activity must never replace durable identity.
describe('resolveTabAgentFromSignals — identity vs liveness', () => {
  it('surfaces the focused idle identity from the record, not the title', () => {
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: true,
        isRemote: true,
        title: 'Terminal',
        hookAgent: null,
        focusedCompletedHookAgent: 'omp',
        launchAgent: undefined
      })
    ).toBe('omp')
  })

  it('ranks the focused idle identity above a hibernated session and launch bootstrap', () => {
    // Completed local hook identity beats sleeping records and stale launch intent.
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: true,
        isRemote: true,
        title: 'Terminal',
        hookAgent: null,
        focusedCompletedHookAgent: 'omp',
        sleepingSessionAgent: 'claude',
        launchAgent: 'codex'
      })
    ).toBe('omp')
  })

  it('never lets a title override a live hook (ground truth)', () => {
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: true,
        isRemote: true,
        title: '✳ Claude Code',
        hookAgent: 'omp',
        launchAgent: undefined
      })
    ).toBe('omp')
  })

  it('lets a different-group title reclaim a reused idle pane without launch metadata', () => {
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: true,
        isRemote: true,
        title: '✳ Claude Code',
        hookAgent: null,
        focusedCompletedHookAgent: 'codex',
        launchAgent: undefined
      })
    ).toBe('claude')
  })

  it('keeps a launchAgent-less pane with a live Pi hook stable on Pi', () => {
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: true,
        isRemote: true,
        title: '⠋ Pi',
        hookAgent: 'pi',
        launchAgent: undefined
      })
    ).toBe('pi')
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: true,
        isRemote: true,
        title: '⠋ Pi',
        hookAgent: null,
        focusedCompletedHookAgent: 'pi',
        launchAgent: undefined
      })
    ).toBe('pi')
  })

  it('keeps a sibling idle identity when the focused pane returns to its shell', () => {
    // Focused-pane exit evidence must not clear still-live sibling identity.
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: true,
        isRemote: false,
        title: 'zsh',
        hookAgent: null,
        focusedCompletedHookAgent: 'claude',
        siblingCompletedHookAgent: 'gemini',
        launchAgent: undefined
      })
    ).toBe('gemini')
  })

  it('does not let a sibling pane re-own the focused pane ambiguous Pi title', () => {
    // Sibling OMP says nothing about focused Pi variant; retain focused-pane title ownership.
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: true,
        isRemote: true,
        title: '⠋ Pi',
        hookAgent: null,
        focusedCompletedHookAgent: null,
        siblingCompletedHookAgent: 'omp',
        launchAgent: undefined
      })
    ).toBe('pi')
  })

  it('does not flash the exited agent before a hookless reuse title reclaims on mount', () => {
    // hasObservedAgentSignal starts false for one mount commit; a completed hook
    // is itself activity evidence, so an anchored reuse title reclaims immediately
    // instead of flashing the prior agent's idle identity. (claude ran+idled,
    // then a hookless codex reused the pane and emits its own title.)
    const onMount = resolveTabAgentFromSignals({
      hasObservedAgentSignal: false,
      isRemote: false,
      title: '⠋ fix the parser - Codex',
      hookAgent: null,
      focusedCompletedHookAgent: 'claude',
      launchAgent: undefined
    })
    const afterObserved = resolveTabAgentFromSignals({
      hasObservedAgentSignal: true,
      isRemote: false,
      title: '⠋ fix the parser - Codex',
      hookAgent: null,
      focusedCompletedHookAgent: 'claude',
      launchAgent: undefined
    })
    expect(onMount).toBe('codex')
    expect(afterObserved).toBe('codex')
  })

  it('does not let a task-text mention reclaim a pane from its completed hook (#24854)', () => {
    // A Codex mention in task text is not an identity claim. A title that is only the agent name is.
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: true,
        isRemote: false,
        title: '⠋ Review Codex behavior',
        hookAgent: null,
        focusedCompletedHookAgent: 'claude',
        launchAgent: undefined
      })
    ).toBe('claude')
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: true,
        isRemote: false,
        title: '⠋ Codex',
        hookAgent: null,
        focusedCompletedHookAgent: 'claude',
        launchAgent: undefined
      })
    ).toBe('codex')
  })
})

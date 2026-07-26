import { describe, expect, it } from 'vitest'
import { resolveTabAgentFromSignals } from './use-tab-agent'

// Pi/OMP share a title-identity group: OMP wraps Pi and emits Pi-compatible
// wrapper title frames. These tests pin how the tab-icon resolver keeps an
// OMP-owned pane on OMP (and a Pi-owned pane on Pi) as those frames arrive,
// including when the pane loses its host-owned launchAgent on a mirrored or
// restored client.
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
    // Why: a mirrored or restored OMP pane loses its host-owned launchAgent but
    // keeps emitting Pi-compatible wrapper title frames. Durable pane identity
    // (last completed hook / hibernated session) must anchor those frames to OMP
    // instead of letting them repaint the tab as Pi.
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
    // The flicker: identity must not flip when the live hook row appears/clears.
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
    // The reported flicker: OMP wraps Pi (`shell → omp → pi`), so the foreground
    // reader alternates between reporting `omp` and `pi` at command boundaries.
    // The process signal outranks launchAgent, so without owner-normalization the
    // OMP-owned tab's icon flips to Pi on every `pi` read. Both reads must land on
    // the launched owner.
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
    // A mirrored/restored OMP pane keeps only its completed-hook identity; a `pi`
    // foreground read (OMP's nested child) must not repaint it to Pi.
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
    // Scope guard: a different-group process (Codex is not Pi-compatible) is
    // real-time proof the pane was reused, so it overrides the OMP launch owner
    // instead of collapsing onto it.
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
    // The fallback must not over-reach: a genuine Pi pane (recent Pi hook) stays
    // Pi even if a stale hibernated OMP record is present.
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

    // An OMP-compatible title on a launchAgent-less Pi pane still resolves to Pi.
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

// The tab icon is a pane's IDENTITY, not its activity state: a hook record
// identifies the pane whether the agent is mid-turn (live) or idle (done). These
// pin that separation so identity can't collapse back into the (non-
// distinguishing) title layer.
describe('resolveTabAgentFromSignals — identity vs liveness', () => {
  it('surfaces the focused idle identity from the record, not the title', () => {
    // Agent went idle between turns; the title names no agent. Identity still
    // comes from the pane's own done-hook record.
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
    // The agent that actually ran and idled here beats both a hibernation record
    // and stale launch intent.
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
    // A launchless pane whose live hook reports Pi resolves to Pi and stays Pi
    // when the hook clears (the completed record is Pi too) — no flip to OMP.
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
    // Focused pane's local shell-exit evidence must not clear the sibling's idle
    // identity — the sibling agent is still there.
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
    // A split-pane sibling running OMP says nothing about which Pi-variant the
    // focused pane runs; the focused pane's own Pi title must stay Pi.
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
    // is itself activity evidence, so the reuse title reclaims immediately
    // instead of flashing the prior agent's idle identity. (claude ran+idled,
    // then a hookless codex reused the pane and emits its own title.)
    const onMount = resolveTabAgentFromSignals({
      hasObservedAgentSignal: false,
      isRemote: false,
      title: '⠋ Codex',
      hookAgent: null,
      focusedCompletedHookAgent: 'claude',
      launchAgent: undefined
    })
    const afterObserved = resolveTabAgentFromSignals({
      hasObservedAgentSignal: true,
      isRemote: false,
      title: '⠋ Codex',
      hookAgent: null,
      focusedCompletedHookAgent: 'claude',
      launchAgent: undefined
    })
    expect(onMount).toBe('codex')
    expect(afterObserved).toBe('codex')
  })
})

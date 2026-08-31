import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// STA-5272 review: every guard this feature depends on lives in a pure module with
// its own unit tests, but `TerminalPane` is mocked out of every suite that touches
// it, so nothing observed that the component still *uses* them. Deleting the whole
// deferral branch, or handing the guard a literal `chunksWritten: 0` over a partial
// write, left all 4357 renderer tests green. These pins are the only thing standing
// between that and a silently reinstated duplicate-bytes paste.
const source = readFileSync(join(__dirname, 'TerminalPane.tsx'), 'utf8').replace(/\r\n?/g, '\n')

function sliceBetween(startAnchor: string, endAnchor: string, within = source): string {
  const start = within.indexOf(startAnchor)
  if (start === -1) {
    throw new Error(`anchor moved or was removed: ${startAnchor}`)
  }
  const end = within.indexOf(endAnchor, start + startAnchor.length)
  if (end === -1) {
    throw new Error(`anchor moved or was removed: ${endAnchor}`)
  }
  return within.slice(start, end)
}

// Scoped, not global: a guard relocated into a function nobody calls has to read as
// absent, so every assertion below is made against the body that actually runs.
const pasteEffect = sliceBetween(
  '  // Intercept paste at keydown:',
  '  }, [isActive, worktreeId, keybindings, forceBracketedMultilineTextPaste, tabId])'
)
const executePanePasteText = sliceBetween(
  '    const executePanePasteText = async (',
  '\n    // Why: resolved per pane and PTY host',
  pasteEffect
)

describe('deferred paste wiring in TerminalPane', () => {
  it('asks the deferral guard with the executor result itself, not fields restated by the caller', () => {
    // Indented verbatim, so `execution` cannot become `{ chunksWritten: 0, ... }`
    // and quietly make a partially written paste look replayable.
    expect(executePanePasteText).toContain(
      [
        '        if (',
        '          allowDeferOnFocusLoss &&',
        '          isDeferrablePasteFocusCancellation({',
        '            execution,',
        '            targetMounted: isPanePasteTargetMounted(pane, transport, ptyId),',
        '            focusMovedToOtherPane: isFocusInsideOtherPane({',
        '              panes: managerRef.current?.getPanes() ?? [],',
        '              paneId: pane.id,',
        '              focusedElement: document.activeElement',
        '            })',
        '          })',
        '        ) {'
      ].join('\n')
    )
  })

  it('defers the payload for that pane and stops, instead of falling through to the error toast', () => {
    expect(executePanePasteText).toContain(
      [
        '          getDeferredPasteQueue().defer({',
        '            paneId: pane.id,',
        '            leafId: pane.leafId,',
        '            source,',
        '            text,',
        '            options',
        '          })',
        '          return',
        '        }',
        '        setTerminalError(formatTerminalPasteExecutionError(execution.reason))'
      ].join('\n')
    )
  })

  it('refuses a second deferral of a redelivered payload, so it cannot loop past its deadline', () => {
    expect(executePanePasteText).toContain('      allowDeferOnFocusLoss = true\n')
    // The redelivery passes `false` positionally; a `true` here reinstates the loop.
    expect(pasteEffect).toContain(
      [
        '      deliver: (pane, deferred) =>',
        '        void executePanePasteText(',
        '          pane,',
        '          deferred.source,',
        '          document.activeElement,',
        '          deferred.text,',
        '          deferred.options,',
        '          false',
        '        ),'
      ].join('\n')
    )
  })

  it('listens for focus coming back and stops listening when the effect tears down', () => {
    expect(pasteEffect).toContain(
      "    container.addEventListener('focusin', onDeferredPasteFocusIn)\n"
    )
    expect(pasteEffect).toContain(
      "      container.removeEventListener('focusin', onDeferredPasteFocusIn)\n"
    )
  })

  it('installs the inert-focus recovery on both paste entry points and disposes it', () => {
    expect(pasteEffect).toContain(
      [
        '    const inertFocusPasteFallback = installInertFocusPasteFallback({',
        '      container,',
        '      onPasteKey: (event) => onKeyPaste(event, true),',
        '      onPasteEvent: (event) => onPaste(event, true)',
        '    })'
      ].join('\n')
    )
    expect(pasteEffect).toContain('      inertFocusPasteFallback.dispose()\n')
  })

  it('puts focus back on the owning pane before a recovered paste runs, on both entry points', () => {
    const recovery = [
      '      if (recoveredFromInertFocus && !restoreInertPaneFocus()) {',
      '        return',
      '      }'
    ].join('\n')
    // Once in onKeyPaste, once in onPaste: a paste recovered from <body> that never
    // restores focus is read by the shared guard as aimed at another surface.
    expect(pasteEffect.split(recovery)).toHaveLength(3)
  })

  it('releases a still-pending payload when the pane unmounts, not merely when the effect re-runs', () => {
    // Outside the paste effect on purpose: its deps include `keybindings`, and a
    // settings change mid-deferral must not drop the payload.
    const unmount = sliceBetween(
      '  const deferredPasteRef = useRef<DeferredTerminalPasteQueue | null>(null)',
      '  const [paneProcessExitsByPaneId'
    )
    expect(unmount).toContain(
      [
        '  useEffect(() => {',
        '    return () => {',
        '      deferredPasteRef.current?.dispose()',
        '      deferredPasteRef.current = null',
        '    }',
        '  }, [])'
      ].join('\n')
    )
    expect(pasteEffect).not.toContain('deferredPasteRef.current?.dispose()')
  })

  it('tells the user which of the three drop causes it actually hit', () => {
    expect(pasteEffect).toContain(
      [
        '          onExpire: () =>',
        '            setTerminalError(',
        "              formatDeferredTerminalPasteDroppedError('deadline-passed', shortcutPlatform)",
        '            )'
      ].join('\n')
    )
    expect(pasteEffect).toContain(
      [
        '      onDropped: (_entry, cause) =>',
        '        setTerminalError(formatDeferredTerminalPasteDroppedError(cause, shortcutPlatform))'
      ].join('\n')
    )
  })
})

// A caller that forgets this handler gets the pre-PR behaviour back for free: a
// clipboard read that FAILED is reported to the user as an EMPTY clipboard, which
// is silence. Checked per call site rather than by counting keywords in the file.
describe('every clipboard paste entry point distinguishes a failed read from an empty one', () => {
  const callSiteArguments = (fileSource: string): string[] => {
    const sites: string[] = []
    const marker = 'pasteTerminalClipboard({'
    for (let at = fileSource.indexOf(marker); at >= 0; at = fileSource.indexOf(marker, at + 1)) {
      let depth = 0
      let end = at + marker.length - 1
      for (; end < fileSource.length; end += 1) {
        const char = fileSource[end]
        if (char === '{') {
          depth += 1
        } else if (char === '}') {
          depth -= 1
          if (depth === 0) {
            break
          }
        }
      }
      sites.push(fileSource.slice(at, end + 1))
    }
    return sites
  }

  const files = ['TerminalPane.tsx', 'terminal-pane-menu-paste.ts']

  it.each(files)('%s hands every call a clipboard-read-unavailable handler', (file) => {
    const fileSource = readFileSync(join(__dirname, file), 'utf8').replace(/\r\n?/g, '\n')
    const sites = callSiteArguments(fileSource)

    expect(sites.length).toBeGreaterThan(0)
    for (const site of sites) {
      expect(site).toContain('onClipboardReadUnavailable')
    }
  })

  it('covers every production caller in the module, so a new one cannot be added unguarded', () => {
    const declared = readFileSync(join(__dirname, 'terminal-clipboard-paste.ts'), 'utf8')
    expect(declared).toContain('onClipboardReadUnavailable?: (error: unknown) => void')
    // Both known importers are in `files`; a third would have to be added here.
    expect(files).toEqual(['TerminalPane.tsx', 'terminal-pane-menu-paste.ts'])
  })
})

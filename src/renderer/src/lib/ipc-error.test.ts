import { describe, expect, it } from 'vitest'
import { i18n } from '../i18n/i18n'
import es from '../i18n/locales/es.json'
import {
  OPENCODE_MODEL_CONFIG_REFUSAL,
  OPENCODE_MODEL_TRANSPORT_REFUSAL,
  OPENCODE_MODEL_VERSION_REFUSAL
} from '../../../shared/agent-launch-model-preferences'
import {
  compactIpcErrorMessage,
  extractIpcErrorMessage,
  readIpcErrorDetail,
  readIpcErrorMessage
} from './ipc-error'

describe('readIpcErrorMessage', () => {
  it('localizes version, configuration and transport refusals without changing other errors', async () => {
    const language = i18n.language
    i18n.addResourceBundle('es', 'translation', es)
    await i18n.changeLanguage('es')
    try {
      for (const [message, expected] of [
        [OPENCODE_MODEL_VERSION_REFUSAL, es.agentLaunch.opencode.updateRequired],
        [OPENCODE_MODEL_CONFIG_REFUSAL, es.agentLaunch.opencode.invalidConfig],
        [OPENCODE_MODEL_TRANSPORT_REFUSAL, es.agentLaunch.opencode.unsupportedLaunch]
      ]) {
        expect(
          readIpcErrorMessage(
            new Error(`Error invoking remote method 'pty:create': OrchestrationError: ${message}`)
          )
        ).toBe(expected)
      }
      expect(readIpcErrorMessage(new Error('OpenCode: another failure'))).toBe(
        'OpenCode: another failure'
      )
    } finally {
      await i18n.changeLanguage(language)
    }
  })

  it('strips the Electron invoke wrapper Electron adds to a rejected handler', () => {
    expect(
      readIpcErrorMessage(
        new Error("Error invoking remote method 'git:stage': Error: index.lock exists")
      )
    ).toBe('index.lock exists')
  })

  it('strips the handler wrapper too', () => {
    expect(
      readIpcErrorMessage(
        new Error("Error occurred in handler for 'skills:discover': EACCES: permission denied")
      )
    ).toBe('EACCES: permission denied')
  })

  it('keeps only the first line, because callers render this as a sonner title', () => {
    // Multiline git/SSH errors reach single-row toast titles/descriptions; keep the compact contract.
    expect(
      readIpcErrorMessage(
        new Error(
          "Error invoking remote method 'fs:import': Error: EACCES: permission denied\nstack 1\nstack 2"
        )
      )
    ).toBe('EACCES: permission denied')
    expect(readIpcErrorMessage(new Error('boom\ndetail'))).toBe('boom')
  })

  it('leaves a plain message untouched', () => {
    expect(readIpcErrorMessage(new Error('Permission denied'))).toBe('Permission denied')
  })

  it('has nothing to show for a non-Error or an empty message', () => {
    expect(readIpcErrorMessage('boom')).toBeUndefined()
    expect(readIpcErrorMessage(undefined)).toBeUndefined()
    expect(readIpcErrorMessage(new Error('   '))).toBeUndefined()
    expect(
      readIpcErrorMessage(new Error("Error invoking remote method 'x': Error: "))
    ).toBeUndefined()
  })
})

describe('compactIpcErrorMessage', () => {
  it('normalizes string error fields without manufacturing an Error', () => {
    expect(
      compactIpcErrorMessage(
        "Error invoking remote method 'files:import': Error: permission denied\nstack"
      )
    ).toBe('permission denied')
  })
})

describe('extractIpcErrorMessage', () => {
  it('unwraps the same way readIpcErrorMessage does', () => {
    expect(
      extractIpcErrorMessage(
        new Error("Error invoking remote method 'git:stage': Error: index.lock exists"),
        'Failed to stage.'
      )
    ).toBe('index.lock exists')
  })

  it('matches main exactly: clamps a WRAPPED multi-line message', () => {
    // Wrapped multiline bodies must not stop at their first newline before compaction.
    expect(
      extractIpcErrorMessage(
        new Error("Error invoking remote method 'git:stage': Error: first\nsecond"),
        'fallback'
      )
    ).toBe('first')
  })

  it('matches main exactly: leaves an UNWRAPPED multi-line message whole', () => {
    // Plain errors feed inline bands and must retain later lines rather than inherit wrapped-error clamping.
    expect(extractIpcErrorMessage(new Error('summary\ndetail'), 'fallback')).toBe('summary\ndetail')
  })

  it('falls back when the error carries nothing readable', () => {
    expect(extractIpcErrorMessage('boom', 'Failed to stage.')).toBe('Failed to stage.')
    expect(extractIpcErrorMessage(new Error('   '), 'Failed to stage.')).toBe('Failed to stage.')
  })
})

describe('readIpcErrorDetail', () => {
  const MULTILINE = new Error(
    "Error invoking remote method 'git:discard': Error: error: unable to unlink 'a': Permission denied\nerror: unable to unlink 'b': Permission denied"
  )

  it('keeps every line, because an inline band is built to show more than one', () => {
    expect(readIpcErrorDetail(MULTILINE)).toBe(
      "error: unable to unlink 'a': Permission denied\nerror: unable to unlink 'b': Permission denied"
    )
  })

  it('is the unclamped half of the pair the toast slots use', () => {
    expect(readIpcErrorMessage(MULTILINE)).toBe("error: unable to unlink 'a': Permission denied")
    // Compact output must remain suitable for single-row toast titles.
    expect(extractIpcErrorMessage(MULTILINE, 'Failed.')).toBe(
      "error: unable to unlink 'a': Permission denied"
    )
  })

  it('has nothing to show for a non-Error or a blank message', () => {
    expect(readIpcErrorDetail('boom')).toBeUndefined()
    expect(readIpcErrorDetail(new Error('   '))).toBeUndefined()
  })

  it('strips a wrapper the caller embedded mid-message, keeping the caller’s own prefix', () => {
    // Preserve caller context such as SSH connection failed while removing nested transport wrappers.
    expect(
      extractIpcErrorMessage(
        new Error(
          "SSH connection failed: Error invoking remote method 'ssh:connect': Error: Relay package not found."
        ),
        'fallback'
      )
    ).toBe('SSH connection failed: Relay package not found.')
  })
})

// Typed main-process class names must not obscure actionable worktree-removal refusal copy (#19334).
describe('typed main-process errors', () => {
  const wrapped = new Error(
    "Error invoking remote method 'worktrees:remove': WorktreeArchiveHookFailedError: " +
      'Archive hook failed for worktree: /w/feature — exited 23.\nbackup target unreachable'
  )

  it('drops the error class name along with the wrapper', () => {
    expect(readIpcErrorDetail(wrapped)).toBe(
      'Archive hook failed for worktree: /w/feature — exited 23.\nbackup target unreachable'
    )
  })

  it('keeps the detail lines a refusal needs, unlike the clamped read', () => {
    // Unclamped archive refusals must retain hook output beyond the first line.
    expect(readIpcErrorMessage(wrapped)).toBe(
      'Archive hook failed for worktree: /w/feature — exited 23.'
    )
  })

  it('leaves a renderer-local error its class name, having unwrapped nothing', () => {
    expect(readIpcErrorDetail(new Error('TypeError: x is not a function'))).toBe(
      'TypeError: x is not a function'
    )
  })

  it('does not mistake an errno prefix for a class name', () => {
    expect(
      readIpcErrorDetail(new Error("Error occurred in handler for 'fs:read': EACCES: denied"))
    ).toBe('EACCES: denied')
  })
})

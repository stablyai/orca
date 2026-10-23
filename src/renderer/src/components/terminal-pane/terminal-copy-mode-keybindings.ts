import { copyModeStrokeMatches } from '../../../../shared/terminal-copy-mode-bindings'
import {
  TERMINAL_COPY_MODE_ACTIONS,
  type TerminalCopyModeAction,
  type TerminalCopyModeConfig
} from '../../../../shared/terminal-copy-mode-config'

type Sequence = { action: TerminalCopyModeAction; steps: string[] }

export function createCopyModeKeybindings(
  config: TerminalCopyModeConfig,
  platform: NodeJS.Platform
) {
  const bindings: Sequence[] = TERMINAL_COPY_MODE_ACTIONS.flatMap((action) =>
    config.bindings[action].map((binding) => ({ action, steps: binding.split(' ') }))
  )
  let pending: Sequence[] | null = null
  let step = 0
  let repeated: { action: TerminalCopyModeAction; code: string } | null = null
  const reset = (): void => {
    pending = null
    step = 0
    repeated = null
  }
  return {
    reset,
    handle(event: KeyboardEvent): TerminalCopyModeAction | 'pending' | null {
      const exit = bindings.find(
        (binding) =>
          binding.action === 'exit' &&
          binding.steps.length === 1 &&
          copyModeStrokeMatches(binding.steps[0], event, platform)
      )
      if (exit) {
        reset()
        return exit.action
      }
      if (['Shift', 'Control', 'Alt', 'AltGraph', 'Meta'].includes(event.key)) {
        return pending ? 'pending' : null
      }
      const code = event.code || event.key
      if (event.repeat && repeated?.code === code) {
        return repeated.action
      }
      if (event.repeat && pending) {
        return 'pending'
      }
      repeated = null
      const matches = (pending ?? bindings).filter((binding) =>
        copyModeStrokeMatches(binding.steps[step], event, platform)
      )
      const complete = matches.find((binding) => binding.steps.length === step + 1)
      if (complete) {
        if (step > 0) {
          repeated = { action: complete.action, code }
        }
        pending = null
        step = 0
        return complete.action
      }
      if (matches.length > 0) {
        pending = matches
        step += 1
        return 'pending'
      }
      reset()
      return null
    }
  }
}

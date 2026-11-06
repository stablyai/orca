import { describe, expect, it } from 'vitest'
import { isRemoteSshEditorCommand } from './remote-ssh-editor-launcher'

describe('remote SSH editor launcher capability', () => {
  it.each(['subl', 'code --reuse-window', 'zed --new', 'open -a "Visual Studio Code"'])(
    'rejects an unsupported or compound command: %s',
    (command) => {
      expect(isRemoteSshEditorCommand(command)).toBe(false)
    }
  )
})

import type { TerminalColorOverrides } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'

export const COLOR_OVERRIDE_GROUPS: {
  label: string
  keys: { key: keyof TerminalColorOverrides; label: string; description: string }[]
}[] = [
  {
    get label() {
      return translate('auto.components.settings.TerminalWindowSection.cf37ff69f6', 'Base')
    },
    keys: [
      {
        key: 'foreground',
        get label() {
          return translate(
            'auto.components.settings.TerminalWindowSection.79f6bfb76e',
            'Foreground'
          )
        },
        get description() {
          return translate(
            'auto.components.settings.TerminalWindowSection.026a0b8013',
            'Main text color'
          )
        }
      },
      {
        key: 'background',
        get label() {
          return translate(
            'auto.components.settings.TerminalWindowSection.cc1b2ffeb2',
            'Background'
          )
        },
        get description() {
          return translate(
            'auto.components.settings.TerminalWindowSection.da64e8f4c1',
            'Terminal background color'
          )
        }
      },
      {
        key: 'cursor',
        get label() {
          return translate('auto.components.settings.TerminalWindowSection.c9e1fdf42f', 'Cursor')
        },
        get description() {
          return translate(
            'auto.components.settings.TerminalWindowSection.cd0700762b',
            'Cursor color'
          )
        }
      },
      {
        key: 'cursorAccent',
        get label() {
          return translate(
            'auto.components.settings.TerminalWindowSection.a2d9f095a7',
            'Cursor Text'
          )
        },
        get description() {
          return translate(
            'auto.components.settings.TerminalWindowSection.7f4063076c',
            'Color of text under the cursor (block cursor)'
          )
        }
      },
      {
        key: 'selectionBackground',
        get label() {
          return translate(
            'auto.components.settings.TerminalWindowSection.40c3cfd30a',
            'Selection Background'
          )
        },
        get description() {
          return translate(
            'auto.components.settings.TerminalWindowSection.74d8555f85',
            'Background color of selected text'
          )
        }
      },
      {
        key: 'selectionForeground',
        get label() {
          return translate(
            'auto.components.settings.TerminalWindowSection.8b450b5305',
            'Selection Foreground'
          )
        },
        get description() {
          return translate(
            'auto.components.settings.TerminalWindowSection.b2c0857c49',
            'Text color of selected text'
          )
        }
      },
      {
        key: 'bold',
        get label() {
          return translate('auto.components.settings.TerminalWindowSection.862e463f7f', 'Bold Text')
        },
        get description() {
          // Why: xterm.js ITheme has no bold color slot (xtermjs/xterm.js#6032); the value is
          // preserved but the terminal renderer does not apply it yet. Keep the copy honest.
          return translate(
            'auto.components.settings.TerminalWindowSection.605a35d600',
            'Not applied by the terminal renderer yet — xterm.js has no bold color slot. A saved value is preserved.'
          )
        }
      }
    ]
  },
  {
    get label() {
      return translate('auto.components.settings.TerminalWindowSection.68e9f07de0', 'ANSI Normal')
    },
    keys: [
      {
        key: 'black',
        get label() {
          return translate('auto.components.settings.TerminalWindowSection.adfdee23cb', 'Black')
        },
        get description() {
          return translate(
            'auto.components.settings.TerminalWindowSection.cf4437a2f7',
            'ANSI black color'
          )
        }
      },
      {
        key: 'red',
        get label() {
          return translate('auto.components.settings.TerminalWindowSection.3a78f30b50', 'Red')
        },
        get description() {
          return translate(
            'auto.components.settings.TerminalWindowSection.b41270f5ca',
            'ANSI red color'
          )
        }
      },
      {
        key: 'green',
        get label() {
          return translate('auto.components.settings.TerminalWindowSection.8f2092b315', 'Green')
        },
        get description() {
          return translate(
            'auto.components.settings.TerminalWindowSection.8a673d4206',
            'ANSI green color'
          )
        }
      },
      {
        key: 'yellow',
        get label() {
          return translate('auto.components.settings.TerminalWindowSection.bb516de873', 'Yellow')
        },
        get description() {
          return translate(
            'auto.components.settings.TerminalWindowSection.09c1c6b096',
            'ANSI yellow color'
          )
        }
      },
      {
        key: 'blue',
        get label() {
          return translate('auto.components.settings.TerminalWindowSection.292a4c7316', 'Blue')
        },
        get description() {
          return translate(
            'auto.components.settings.TerminalWindowSection.9635a71c51',
            'ANSI blue color'
          )
        }
      },
      {
        key: 'magenta',
        get label() {
          return translate('auto.components.settings.TerminalWindowSection.d5e92fcd94', 'Magenta')
        },
        get description() {
          return translate(
            'auto.components.settings.TerminalWindowSection.1705318506',
            'ANSI magenta color'
          )
        }
      },
      {
        key: 'cyan',
        get label() {
          return translate('auto.components.settings.TerminalWindowSection.fb8bb4eb1f', 'Cyan')
        },
        get description() {
          return translate(
            'auto.components.settings.TerminalWindowSection.bd4c759327',
            'ANSI cyan color'
          )
        }
      },
      {
        key: 'white',
        get label() {
          return translate('auto.components.settings.TerminalWindowSection.0cb4459fb8', 'White')
        },
        get description() {
          return translate(
            'auto.components.settings.TerminalWindowSection.28846b1ca6',
            'ANSI white color'
          )
        }
      }
    ]
  },
  {
    get label() {
      return translate('auto.components.settings.TerminalWindowSection.1be593d3e8', 'ANSI Bright')
    },
    keys: [
      {
        key: 'brightBlack',
        get label() {
          return translate(
            'auto.components.settings.TerminalWindowSection.260d69ce9a',
            'Bright Black'
          )
        },
        get description() {
          return translate(
            'auto.components.settings.TerminalWindowSection.f30c492769',
            'ANSI bright black color'
          )
        }
      },
      {
        key: 'brightRed',
        get label() {
          return translate(
            'auto.components.settings.TerminalWindowSection.32b1b6acd7',
            'Bright Red'
          )
        },
        get description() {
          return translate(
            'auto.components.settings.TerminalWindowSection.667de68863',
            'ANSI bright red color'
          )
        }
      },
      {
        key: 'brightGreen',
        get label() {
          return translate(
            'auto.components.settings.TerminalWindowSection.7dafd57730',
            'Bright Green'
          )
        },
        get description() {
          return translate(
            'auto.components.settings.TerminalWindowSection.0ffb02f921',
            'ANSI bright green color'
          )
        }
      },
      {
        key: 'brightYellow',
        get label() {
          return translate(
            'auto.components.settings.TerminalWindowSection.936a326be3',
            'Bright Yellow'
          )
        },
        get description() {
          return translate(
            'auto.components.settings.TerminalWindowSection.e2ef5f4ab7',
            'ANSI bright yellow color'
          )
        }
      },
      {
        key: 'brightBlue',
        get label() {
          return translate(
            'auto.components.settings.TerminalWindowSection.66820332fa',
            'Bright Blue'
          )
        },
        get description() {
          return translate(
            'auto.components.settings.TerminalWindowSection.bef6c0f6bf',
            'ANSI bright blue color'
          )
        }
      },
      {
        key: 'brightMagenta',
        get label() {
          return translate(
            'auto.components.settings.TerminalWindowSection.e56e7d6ea0',
            'Bright Magenta'
          )
        },
        get description() {
          return translate(
            'auto.components.settings.TerminalWindowSection.fe4d89ef85',
            'ANSI bright magenta color'
          )
        }
      },
      {
        key: 'brightCyan',
        get label() {
          return translate(
            'auto.components.settings.TerminalWindowSection.f94adc4113',
            'Bright Cyan'
          )
        },
        get description() {
          return translate(
            'auto.components.settings.TerminalWindowSection.1601140f03',
            'ANSI bright cyan color'
          )
        }
      },
      {
        key: 'brightWhite',
        get label() {
          return translate(
            'auto.components.settings.TerminalWindowSection.16948119cb',
            'Bright White'
          )
        },
        get description() {
          return translate(
            'auto.components.settings.TerminalWindowSection.42e01a6055',
            'ANSI bright white color'
          )
        }
      }
    ]
  }
]

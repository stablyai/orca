import { Keyboard } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { translate } from '@/i18n/i18n'

/** One supported keystroke and what it does. Keys are literal Vim tokens and never translated. */
type VimCommand = { keys: string; description: string }
type VimCommandGroup = { title: string; commands: VimCommand[] }

/**
 * Curated reference of the monaco-vim commands Orca's editor supports, grouped by task, plus the
 * documented limitations. Surfaced from a hint button in the Vim status bar. Keystrokes stay
 * literal; only the prose is localized.
 */
function buildCommandGroups(): VimCommandGroup[] {
  return [
    {
      title: translate('auto.components.editor.VimCheatsheet.groupModes', 'Modes'),
      commands: [
        {
          keys: 'i / a',
          description: translate(
            'auto.components.editor.VimCheatsheet.cmdInsert',
            'Insert before / after the cursor'
          )
        },
        {
          keys: 'o / O',
          description: translate(
            'auto.components.editor.VimCheatsheet.cmdOpenLine',
            'Open a new line below / above'
          )
        },
        {
          keys: 'v / V',
          description: translate(
            'auto.components.editor.VimCheatsheet.cmdVisual',
            'Character / line visual selection'
          )
        },
        {
          keys: 'Esc',
          description: translate(
            'auto.components.editor.VimCheatsheet.cmdNormal',
            'Return to normal mode'
          )
        }
      ]
    },
    {
      title: translate('auto.components.editor.VimCheatsheet.groupMotions', 'Move'),
      commands: [
        {
          keys: 'h j k l',
          description: translate(
            'auto.components.editor.VimCheatsheet.cmdArrows',
            'Left, down, up, right'
          )
        },
        {
          keys: 'w / b / e',
          description: translate(
            'auto.components.editor.VimCheatsheet.cmdWord',
            'Next / previous / end of word'
          )
        },
        {
          keys: '0 / ^ / $',
          description: translate(
            'auto.components.editor.VimCheatsheet.cmdLineEnds',
            'Start, first non-blank, end of line'
          )
        },
        {
          keys: 'gg / G',
          description: translate(
            'auto.components.editor.VimCheatsheet.cmdFileEnds',
            'Top / bottom of file'
          )
        },
        {
          keys: 'f / t',
          description: translate(
            'auto.components.editor.VimCheatsheet.cmdFindChar',
            'Jump to / before a character'
          )
        },
        {
          keys: '%',
          description: translate(
            'auto.components.editor.VimCheatsheet.cmdMatchPair',
            'Jump to matching bracket'
          )
        }
      ]
    },
    {
      title: translate('auto.components.editor.VimCheatsheet.groupEdit', 'Edit'),
      commands: [
        {
          keys: 'x',
          description: translate(
            'auto.components.editor.VimCheatsheet.cmdDeleteChar',
            'Delete the character'
          )
        },
        {
          keys: 'dd / dw',
          description: translate(
            'auto.components.editor.VimCheatsheet.cmdDelete',
            'Delete line / word'
          )
        },
        {
          keys: 'cc / cw',
          description: translate(
            'auto.components.editor.VimCheatsheet.cmdChange',
            'Change line / word'
          )
        },
        {
          keys: 'yy / p',
          description: translate(
            'auto.components.editor.VimCheatsheet.cmdYankPaste',
            'Yank line / paste'
          )
        },
        {
          keys: '>> / <<',
          description: translate(
            'auto.components.editor.VimCheatsheet.cmdIndent',
            'Indent / outdent line'
          )
        },
        {
          keys: 'u / Ctrl-r',
          description: translate('auto.components.editor.VimCheatsheet.cmdUndoRedo', 'Undo / redo')
        },
        {
          keys: '.',
          description: translate(
            'auto.components.editor.VimCheatsheet.cmdRepeat',
            'Repeat the last change'
          )
        },
        {
          keys: 'qa … q / @a',
          description: translate(
            'auto.components.editor.VimCheatsheet.cmdMacro',
            'Record / replay a macro'
          )
        }
      ]
    },
    {
      title: translate('auto.components.editor.VimCheatsheet.groupSearch', 'Search & command'),
      commands: [
        {
          keys: '/ ?  n N',
          description: translate(
            'auto.components.editor.VimCheatsheet.cmdSearch',
            'Search forward / back, next / previous'
          )
        },
        {
          keys: '* / #',
          description: translate(
            'auto.components.editor.VimCheatsheet.cmdSearchWord',
            'Search word under cursor'
          )
        },
        {
          keys: ':%s/a/b/g',
          description: translate(
            'auto.components.editor.VimCheatsheet.cmdSubstitute',
            'Substitute (no live preview)'
          )
        },
        {
          keys: ':w',
          description: translate('auto.components.editor.VimCheatsheet.cmdWrite', 'Save the file')
        },
        {
          keys: ':wq / :x',
          description: translate(
            'auto.components.editor.VimCheatsheet.cmdWriteQuit',
            'Save and close'
          )
        },
        {
          keys: ':q / :q!',
          description: translate('auto.components.editor.VimCheatsheet.cmdQuit', 'Close the editor')
        },
        {
          keys: ':set nu / nowrap / ts=4',
          description: translate(
            'auto.components.editor.VimCheatsheet.cmdSet',
            'Line numbers, wrap, tab width'
          )
        }
      ]
    }
  ]
}

/** Known monaco-vim limitations worth calling out so they do not read as bugs. */
function buildUnsupported(): string {
  return translate(
    'auto.components.editor.VimCheatsheet.unsupported',
    'Not supported: gd (go-to-definition), :%s live-preview highlighting, and Backspace replay inside a recorded macro.'
  )
}

/** Hint button + popover listing the supported Vim commands, shown in the editor status bar. */
export function VimCheatsheet(): React.JSX.Element {
  const groups = buildCommandGroups()
  const triggerLabel = translate(
    'auto.components.editor.VimCheatsheet.triggerLabel',
    'Vim commands'
  )
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={triggerLabel}
          title={triggerLabel}
          className="flex shrink-0 items-center rounded px-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <Keyboard className="size-3.5" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="top"
        className="scrollbar-sleek max-h-[60vh] w-80 overflow-y-auto"
      >
        <div className="mb-2 text-sm font-medium text-foreground">
          {translate('auto.components.editor.VimCheatsheet.title', 'Vim command reference')}
        </div>
        <div className="space-y-3">
          {groups.map((group) => (
            <div key={group.title}>
              <div className="mb-1 text-xs font-medium text-muted-foreground">{group.title}</div>
              <ul className="space-y-0.5">
                {group.commands.map((command) => (
                  <li
                    key={command.keys}
                    className="flex items-baseline justify-between gap-3 text-xs"
                  >
                    <code className="shrink-0 font-mono text-foreground">{command.keys}</code>
                    <span className="min-w-0 text-right text-muted-foreground">
                      {command.description}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <p className="mt-3 border-t border-border pt-2 text-[11px] text-muted-foreground">
          {buildUnsupported()}
        </p>
      </PopoverContent>
    </Popover>
  )
}

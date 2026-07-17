import type { ITerminalAddon, Terminal } from '@xterm/xterm'

type LigatureRange = [number, number]

export type TerminalLigatureOptions = {
  fallbackLigatures: string[]
  fontFeatureSettings: string
}

const DEFAULT_FALLBACK_LIGATURES = [
  '<--',
  '<---',
  '<<-',
  '<-',
  '->',
  '->>',
  '-->',
  '--->',
  '<==',
  '<===',
  '<<=',
  '<=',
  '=>',
  '=>>',
  '==>',
  '===>',
  '>=',
  '>>=',
  '<->',
  '<-->',
  '<--->',
  '<---->',
  '<=>',
  '<==>',
  '<===>',
  '<====>',
  '::',
  ':::',
  '<~~',
  '</',
  '</>',
  '/>',
  '~~>',
  '==',
  '!=',
  '/=',
  '~=',
  '<>',
  '===',
  '!==',
  '!===',
  '<:',
  ':=',
  '*=',
  '*+',
  '<*',
  '<*>',
  '*>',
  '<|',
  '<|>',
  '|>',
  '+*',
  '=*',
  '=:',
  ':>',
  '/*',
  '*/',
  '+++',
  '<!--',
  '<!---'
].sort((left, right) => right.length - left.length)

function resolveLigatureRanges(
  text: string,
  fallbackLigatures: readonly string[]
): LigatureRange[] {
  const ranges: LigatureRange[] = []
  for (let index = 0; index < text.length; index++) {
    const match = fallbackLigatures.find((ligature) => text.startsWith(ligature, index))
    if (!match) {
      continue
    }
    ranges.push([index, index + match.length])
    index += match.length - 1
  }
  return ranges
}

export class LigaturesAddon implements ITerminalAddon {
  private readonly fallbackLigatures: readonly string[]
  private readonly fontFeatureSettings?: string
  private terminal: Terminal | undefined
  private characterJoinerId: number | undefined

  constructor(options?: Partial<TerminalLigatureOptions>) {
    this.fallbackLigatures = options?.fallbackLigatures ?? DEFAULT_FALLBACK_LIGATURES
    this.fontFeatureSettings = options?.fontFeatureSettings
  }

  activate(terminal: Terminal): void {
    if (!terminal.element) {
      throw new Error('Cannot activate LigaturesAddon before open is called')
    }

    this.terminal = terminal
    this.characterJoinerId = terminal.registerCharacterJoiner((text) =>
      resolveLigatureRanges(text, this.fallbackLigatures)
    )
    terminal.element.style.fontFeatureSettings = this.fontFeatureSettings ?? '"calt" on, "liga" on'
  }

  dispose(): void {
    if (this.terminal && this.characterJoinerId !== undefined) {
      this.terminal.deregisterCharacterJoiner(this.characterJoinerId)
      this.characterJoinerId = undefined
    }
    if (this.terminal?.element) {
      this.terminal.element.style.fontFeatureSettings = ''
    }
    this.terminal = undefined
  }
}

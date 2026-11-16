// Monaco's unicode tables, reachable without evaluating the editor's NLS bundle.
declare module 'monaco-editor/esm/vs/base/common/strings.js' {
  export class AmbiguousCharacters {
    static getInstance(locales: Set<string>): AmbiguousCharacters
    static getLocales(): string[]
    isAmbiguous(codePoint: number): boolean
    getConfusableCodePoints(): ReadonlySet<number>
  }
  export class InvisibleCharacters {
    static isInvisibleCharacter(codePoint: number): boolean
    static get codePoints(): ReadonlySet<number>
  }
}

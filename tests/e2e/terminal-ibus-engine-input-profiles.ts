// Keystroke scripts and committed-text expectations for the native IBus E2E
// suite. Session configuration (apt package, GSettings, `ibus engine` name)
// lives in config/scripts/terminal-ibus-engine-profiles.mjs; the engine ids in
// both files must match, which the workflow contract test enforces.

export type NativeIbusInputDriver = {
  key: (keyName: string) => void
  type: (text: string) => void
  typeClearingModifiers: (text: string) => void
}

export type NativeIbusEngineScenario = {
  title: string
  /** Text the engine is expected to hand to the PTY, excluding the newline. */
  expectedText: string
  drive: (driver: NativeIbusInputDriver) => void
}

export type NativeIbusEngineInputProfile = {
  /** Argument to `ibus engine`; case-sensitive. */
  ibusEngineName: string
  /**
   * Every committed line must match this. It is the engine-independent half of
   * the oracle: it holds even when the exact glyphs depend on a dictionary.
   */
  committedScriptPattern: RegExp
  /**
   * False while `expectedText` is derived from engine source rather than from a
   * recorded CI run. Unverified expectations are asserted softly so one
   * observational run reports both the structural verdict and the real text.
   */
  expectationsVerified: boolean
  scenarios: NativeIbusEngineScenario[]
}

export const nativeIbusEngineInputProfiles: Record<string, NativeIbusEngineInputProfile> = {
  hangul: {
    ibusEngineName: 'hangul',
    committedScriptPattern: /[\uac00-\ud7af]/,
    expectationsVerified: true,
    scenarios: [
      {
        title: 'forwards the issue exact-byte sequence without loss or duplication',
        expectedText: '한abc글',
        drive: ({ key, type, typeClearingModifiers }) => {
          typeClearingModifiers('gks')
          key('Hangul')
          type('abc')
          key('Hangul')
          type('rmf')
          key('Return')
        }
      },
      {
        title: 'forwards the issue sentence stress sequence without leaked ASCII',
        expectedText: '테스트를 하고 있는데 여전히 그러네',
        drive: ({ key, typeClearingModifiers }) => {
          typeClearingModifiers('xptmxmfmf gkrh dlTsmsep duwjsgl rmfjsp')
          key('Return')
        }
      }
    ]
  },

  // Space selects the highlighted candidate and is consumed; Enter is only
  // forwarded once the editor text is empty, so the newline needs no extra key.
  // The candidate itself comes from the bundled libpinyin model, so the glyphs
  // are a prediction until CI records them.
  libpinyin: {
    ibusEngineName: 'libpinyin',
    committedScriptPattern: /[\u4e00-\u9fff]/,
    expectationsVerified: false,
    scenarios: [
      {
        title: 'commits one Pinyin candidate per repetition without leaked Latin',
        expectedText: '你好',
        drive: ({ key, typeClearingModifiers }) => {
          typeClearingModifiers('nihao')
          key('space')
          key('Return')
        }
      }
    ]
  },

  // Romaji with no space, so Anthy never enters conversion and the committed
  // text is the kana transliteration rather than a dictionary lookup. The first
  // Enter commits the preedit and is consumed; the second reaches the PTY.
  // "hiragana" is four plain CV syllables, avoiding the ambiguous romaji `n`.
  anthy: {
    ibusEngineName: 'anthy',
    committedScriptPattern: /[\u3040-\u309f]/,
    expectationsVerified: false,
    scenarios: [
      {
        title: 'commits the romaji-to-kana preedit without leaked Latin',
        expectedText: 'ひらがな',
        drive: ({ key, typeClearingModifiers }) => {
          typeClearingModifiers('hiragana')
          key('Return')
          key('Return')
        }
      }
    ]
  },

  // Telex is rule-based, so no dictionary decides the glyphs. Space is a word
  // break: it is committed with the first word. Enter commits the buffer and is
  // forwarded, so it both flushes and sends the newline. All lowercase, because
  // a Shift press is Unikey's restore-keystrokes trigger.
  unikey: {
    ibusEngineName: 'Unikey',
    committedScriptPattern: /[\u1ea0-\u1ef9]/,
    expectationsVerified: false,
    scenarios: [
      {
        title: 'commits Telex diacritics without leaked keystroke Latin',
        expectedText: 'tiếng việt',
        drive: ({ key, typeClearingModifiers }) => {
          typeClearingModifiers('tieengs vieejt')
          key('Return')
        }
      }
    ]
  }
}

export function resolveNativeIbusEngineInputProfile(
  engineId: string | undefined
): NativeIbusEngineInputProfile | undefined {
  return engineId ? nativeIbusEngineInputProfiles[engineId] : undefined
}

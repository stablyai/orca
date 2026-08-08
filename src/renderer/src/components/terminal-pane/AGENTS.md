# IME Composition

Scoped here rather than to the root `AGENTS.md` so it costs context only when you are working in
the terminal input path. These rules also bind the chat composer and the mobile composer; if you are
changing keyboard handling in those, read this file.

Each rule below was paid for by a shipped defect. The parenthetical is the issue that taught it.

- **Derive committed text from ranges and event data — never by diffing two observations of a mutable
  buffer.** When the evidence is ambiguous, emit nothing. Diffing races the IME's own edits.

- **Match shortcuts on `event.code`, not `event.key`.** A CJK input source rewrites `key` while `code`
  keeps the physical key: Cmd+C arrives as `{ key: "ㅊ", code: "KeyC" }`, and `Shift+T` typing ㅆ has
  been misread as Enter. Use `@/lib/ime-latin-shortcut-key`. (#12171, #13033)

- **`keyCode === 229` means an IME owns the press.** Translating it races the IME's commit. Existing
  guards in `terminal-jis-yen-input.ts` show the shape.

- **Guard above the key dispatch, not inside each key branch**, and guard `keyup` and global
  `document` listeners too — a guard on `keydown` alone leaves the other edges unprotected.

- **`attachCustomKeyEventHandler` returning `false` does NOT call `preventDefault()`**, and it bypasses
  xterm's `CompositionHelper` entirely. Pair the two deliberately.

- **Never normalize IME output at commit.** Normalize only at path handling and equality/search
  comparison. Normalizing early destroys the distinction between conjoining and compatibility jamo.

- **Do not unmount a field with a composition in flight.** The OS aborts the composition, the text
  returns as committed, and a resumed Hangul syllable degrades — 아 then ㄴ yields `아ㄴ`, never `안`.
  Hiding is not a fix: `display:none` and `visibility:hidden` both blur the focused element and abort
  it the same way. See `native-chat-composer-composition-hold.ts`. (#12118, STA-3219, #11332)

## Evidence bar for a change here

- **A recorded event-trace fixture** for the trace that motivated the change — not a hand-authored
  event shape. Real IMEs produce sequences nobody guesses correctly; see
  `tests/e2e/terminal-ime-observed-event-sequences.ts`.
- **A paired negative** proving ordinary non-IME input is unchanged. It must be a genuine control:
  an arm that dispatches `compositionupdate` is a Latin *preedit*, not ordinary input.
- **A mutation check.** Removing or bypassing the fix must make the positive fail while the negative
  passes. A test that survives deleting the code it guards is guarding nothing.

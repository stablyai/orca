// Why: Monarch compiles every rule as `^(?:...)` at the tokenizer position, so a rule only
// matches a candidate when the match starts at index 0. The rule regexes stay unanchored
// (a literal `^` flips Monaco's `matchOnlyAtLineStart`), so tests simulate the anchoring.
export function matchMonarchRuleAtStart(pattern: RegExp, input: string): RegExpExecArray | null {
  const match = pattern.exec(input)
  return match !== null && match.index === 0 ? match : null
}

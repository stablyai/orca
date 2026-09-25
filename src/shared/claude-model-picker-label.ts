/** Enrich family-only CLI labels with the version reported by the same execution host. */
export function claudeModelPickerLabel(
  label: string,
  resolvedModel: unknown,
  description: unknown
): string {
  const family = label.match(/^(?:Claude\s+)?(Opus|Sonnet|Haiku)\b/i)
  if (!family || /^\s+\d/.test(label.slice(family[0].length))) {
    return label
  }
  const resolved =
    typeof resolvedModel === 'string'
      ? resolvedModel.match(
          /^claude-(opus|sonnet|haiku)-(\d+)(?:[-.](\d{1,2}))?(?:-\d{8})?(?:\[[^\]]+\])?$/i
        )
      : null
  const described =
    typeof description === 'string'
      ? description.match(/\b(Opus|Sonnet|Haiku)\s+(\d+(?:\.\d+)?)\b/i)
      : null
  const reportedFamily = resolved?.[1] ?? described?.[1]
  if (reportedFamily?.toLowerCase() !== family[1].toLowerCase()) {
    return label
  }
  const version = resolved ? [resolved[2], resolved[3]].filter(Boolean).join('.') : described?.[2]
  return version ? `${family[0]} ${version}${label.slice(family[0].length)}` : label
}

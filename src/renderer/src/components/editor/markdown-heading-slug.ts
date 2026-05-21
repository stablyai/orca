// Scoped local fork of github-slugger@2.0.0 / rehype-slug@6.0.0 behavior.
// Why: Orca only needs heading slug generation + duplicate suffixing, so we
// keep that behavior local instead of shipping two extra runtime packages.
const markdownSlugPunctuationPattern = /[^\p{L}\p{M}\p{N} _-]/gu

export class MarkdownHeadingSlugger {
  private readonly occurrences = new Map<string, number>()

  reset(): void {
    this.occurrences.clear()
  }

  slug(value: string): string {
    const baseSlug = slugMarkdownHeading(value)
    let nextSlug = baseSlug

    while (this.occurrences.has(nextSlug)) {
      const nextCount = (this.occurrences.get(baseSlug) ?? 0) + 1
      this.occurrences.set(baseSlug, nextCount)
      nextSlug = `${baseSlug}-${nextCount}`
    }

    this.occurrences.set(nextSlug, 0)
    return nextSlug
  }
}

export function slugMarkdownHeading(value: string): string {
  return value.toLowerCase().replace(markdownSlugPunctuationPattern, '').replace(/ /g, '-')
}

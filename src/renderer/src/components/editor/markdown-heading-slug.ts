// Scoped local fork of github-slugger@2.0.0 behavior.
// Why: TOC/editor anchors need to match rehype-slug@6.0.0 preview IDs without
// adding a direct github-slugger runtime dependency.
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

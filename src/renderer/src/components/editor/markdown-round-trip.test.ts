import { describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import type { SlashCommandId } from './rich-markdown-slash-commands'
import { slashCommands } from './rich-markdown-slash-commands'

const REPORT_DOCUMENT_FIXTURE = [
  '# Fix report: details blocks disabling rich mode',
  '',
  '## Decision: option A (stop unconditionally writing the styling class into markdown output)',
  '',
  'Traced every consumer of `class="orca-details"` before choosing:',
  '',
  "- The rendered DOM node gets the class independently, from `OrcaDetails.configure({ HTMLAttributes: { class: 'orca-details' } })` in `rich-markdown-details-extension.ts` — this does not read the markdown source string at all.",
  '- `renderDetailsAttributes` (`details-markdown-html.ts`) had exactly one call site: the markdown serializer itself. Nothing else in the pipeline reads the class from serialized markdown text.',
  '- The tokenizer already treats the class as optional: `hasOnlySupportedDetailsAttributes` strips it if present but never requires it, and `isEditableDetailsHtmlBlock` accepts a bare `<details>` with no class. Any other class value (or any other unrecognized attribute, e.g. `id="x"`) fails that check entirely and the block is kept as passthrough HTML, whose raw source bytes are never touched by the details serializer.',
  "- The read-only preview (`MarkdownPreviewBody.tsx`) allowlists `className: 'orca-details'` through `rehype-sanitize` *if the source HTML already has it* — it does not inject the class. A GitHub-authored file with no class already rendered unstyled in preview before this fix; that is unchanged, not something this fix touches.",
  '',
  "A newly created or user-authored `<details>` block should never have Orca write a styling class into its markdown source — GitHub-flavored files never carry that class, and the DOM styling path doesn't need it in the source. But a file already saved by an earlier Orca version does carry the class in its source, and dropping it unconditionally caused a second bug: the round-trip eligibility check compares serialized output against the source's literal bytes, so a legacy file that loses its class on save stops matching and regresses back to Source mode.",
  '',
  'The final design: `parseDetailsAttributes` records whether the block\'s opening tag had the legacy class (`hasLegacyStylingClass`), that flag is carried on the TipTap node as a genuine schema attribute (declared in `OrcaDetails.addAttributes`, alongside the existing `variant` attribute, so it survives edits and undo), and `renderDetailsAttributes` re-emits `class="orca-details"` only when the flag is set. A block with no class in its source stays classless through every subsequent save; a block that already had the class keeps it.',
  '',
  "User-provided attributes (a custom `class`, an `id`, etc.) don't need special handling under this design — they never reach the details tokenizer at all. `isEditableDetailsHtmlBlock` rejects any attribute outside its allowlist (`open`, the legacy class, `data-orca-toggle`), so those blocks are treated as opaque passthrough HTML and their source bytes round-trip verbatim, untouched by `renderDetailsAttributes`. Verified directly (see below).",
  '',
  '## Commits',
  '',
  '- `93f807fbfd59a9854ecb3bf24c0a3a1051a9b79f` — initial fix: serializer stops always writing the class.',
  '- `6213aa9a99fb7717a5d968b6bbd21a00d66e2374` — follow-up: preserves the class when the source already had it, fixing a legacy-file regression the initial commit introduced.',
  '',
  'Both on branch `fb/rtme-details-roundtrip` in `/Users/fbarthelemy/Code/orca/fb-rtme-details/`.',
  '',
  '## Review findings and verification',
  '',
  "Before making the follow-up change, ran three ad hoc probe tests against the first commit's code to check for regressions, all removed after verification:",
  '',
  '- Case — Source — Result before fix #2',
  '- Legacy Orca-saved file — `<details class="orca-details">…` — `getMarkdownRichModeUnsupportedReason` returned `\'html-or-jsx\'` — **confirmed regression**, the file would fall back to Source mode.',
  '- User custom class — `<details class="my-notes" open>…` — Round-tripped byte-identical to input; eligibility `null`. Passthrough HTML, unaffected.',
  '- User `id` attribute — `<details id="x">…` — Round-tripped byte-identical to input; eligibility `null`. Passthrough HTML, unaffected.',
  '',
  'After the follow-up commit, re-ran the same three probes plus a bare-details control:',
  '',
  '- Case — Result after fix #2',
  '- Legacy Orca-saved file — `getMarkdownRichModeUnsupportedReason` returns `null`; round-trips byte-identical to source.',
  "- Bare `<details>` with no class — Still gets no class on save (fix #1's intent preserved).",
  '- User custom class / `id` — Unchanged — still passthrough, still byte-identical.',
  '',
  'All four passed. These are now permanent tests: `markdown-rich-mode.test.ts` ("allows a details block already carrying the legacy orca-details class"), `markdown-round-trip.test.ts` ("round-trips an orca-authored nested toggle unchanged", restored to its original byte-identical assertion, plus a new "does not backfill the legacy styling class onto a freshly nested toggle" case covering a legacy outer block wrapping a freshly authored inner block).',
  '',
  '## Diff summary',
  '',
  '**Commit 1** (`93f807fb`):',
  '',
  '- `details-markdown-html.ts`: `renderDetailsAttributes` stops prepending `class="orca-details"` unconditionally.',
  '- `rich-markdown-details-extension.ts`: `renderMarkdown` only adds a leading space before the attribute string when attributes exist, avoiding a stray `<details >`.',
  '- Test files updated to match the new (classless) serialized output.',
  '',
  '**Commit 2** (`6213aa9a`):',
  '',
  "- `rich-markdown-details-extension.ts`: `OrcaDetails.addAttributes` gains `hasLegacyStylingClass` (default `false`, not a DOM attribute — `parseHTML`/`renderHTML` are no-ops since it's markdown-only state).",
  '- `details-markdown-html.ts`: `parseDetailsAttributes` sets `hasLegacyStylingClass` from a new `LEGACY_STYLING_CLASS_PATTERN` regex matching only the exact `class="orca-details"` form (the only class value `hasOnlySupportedDetailsAttributes` tolerates). `renderDetailsAttributes` re-emits the class when that flag is `true`.',
  '- `markdown-rich-mode.test.ts`: added the legacy-class eligibility regression test.',
  '- `markdown-round-trip.test.ts`: restored the nested-legacy-toggle test to its original byte-identical assertion (previously incorrectly rewritten in commit 1 to expect the class dropped); added the backfill-prevention test.',
  '',
  '## Commands run (final state, after both commits)',
  '',
  '- Command — Result',
  '- `pnpm test src/renderer/src/components/editor` — pass — 208 files, 1416 tests, 2 skipped',
  '- `pnpm tc` — pass — no type errors',
  '- `npx oxlint` (full repo) — pass — exit 0, no findings',
  '- `npx oxfmt --write` on changed files — applied, no changes needed on the second pass',
  '- pre-commit hook (oxlint + oxfmt via lint-staged), both commits — pass, no manual fixes needed',
  '',
  '## Draft: GitHub issue',
  '',
  '**Title:** `[Bug]: Markdown files with <details> blocks always open in Source mode`',
  '',
  '**Body:**',
  '',
  '### Operating system',
  '',
  'macOS',
  '',
  '### Orca version',
  '',
  '1.4.198',
  '',
  '### Details',
  '',
  'Opening a markdown file that contains a `<details>` disclosure block always lands in Source mode with the "this file contains HTML, JSX, or MDX" banner, even for the smallest possible block and even though Orca has a dedicated rich-editor extension for details blocks that never gets a chance to run.',
  '',
  'Minimal reproduction: create a markdown file containing exactly this and open it in Orca.',
  '',
  '```markdown',
  '<details>',
  '<summary>x</summary>',
  '',
  'body',
  '',
  '</details>',
  '```',
  '',
  'Expected: the file opens in the rich editor with the details block rendered as a collapsible toggle.',
  '',
  'Actual: the file falls back to Source mode with the HTML/JSX/MDX banner.',
  '',
  'The mechanism is that the markdown serializer always adds `class="orca-details"` to the `<details>` tag it writes out ([`renderDetailsAttributes`](https://github.com/stablyai/orca/blob/7dd183d82dafb768bb2506d161438a6d0894fd53/src/renderer/src/components/editor/details-markdown-html.ts#L79-L92)), and the rich-mode eligibility check compares that serialized output against the file\'s literal opening tag byte-for-byte ([`preservesEmbeddedHtml`](https://github.com/stablyai/orca/blob/7dd183d82dafb768bb2506d161438a6d0894fd53/src/renderer/src/components/editor/markdown-rich-mode.ts#L211-L221)), so a source file without that class never matches and the file is treated as unsupported HTML.',
  '',
  '## Draft: PR body',
  '',
  '## ELI5',
  '',
  'Any markdown file with a `<details>` disclosure block used to always open in Source mode instead of the rich editor, even for a two-line block with no attributes.',
  '',
  '## What Changed',
  '',
  'The markdown serializer only writes `class="orca-details"` into a saved `<details>` tag when the file\'s own source already had that class. A block authored fresh, or one that came from a plain markdown file, never gets the class written into it, since the class is already applied to the rendered editor node independently through the extension\'s `HTMLAttributes` configuration.',
  '',
  '## Why',
  '',
  "Rich-mode eligibility detects embedded HTML and then verifies it survives a round trip through the editor by comparing the re-serialized output against the source's literal opening tag. The serializer used to always add a class the source didn't have, so that comparison failed for every `<details>` block that didn't already carry the class, and the file fell back to Source mode. Making the class conditional on the source removes the mismatch at its origin, and keeps files already saved by Orca (which do carry the class) round-tripping unchanged.",
  '',
  '## Linked Issue',
  '',
  'Fixes #TBD',
  '',
  '## Visual Proof',
  '',
  '**Before:** opening a markdown file containing a details block lands in Source mode with the HTML banner, and the collapsible toggle is not interactive.',
  '',
  '**After:** the same file opens in the rich editor with the details block rendered as a collapsible block.',
  '',
  '## Testing',
  '',
  '- [ ] I manually tested these changes locally',
  '- [x] Automated tests added/updated, or explained why not below',
  '',
  "Added regression tests in `markdown-rich-mode.test.ts` for a minimal bare details block, one with `open`, one already carrying the legacy styling class, and a full document shape (front matter, prose, a details block with bold text/link/list/fenced code, a second `<details open>` block). Updated existing round-trip assertions in `markdown-round-trip.test.ts` and `rich-markdown-details-keyboard.test.ts` to match; added a test confirming a legacy-class outer block doesn't backfill the class onto a freshly authored nested block; confirmed by test that user-provided attributes like a custom `class` or `id` are unaffected, since those blocks are treated as passthrough HTML rather than going through this serializer. `pnpm test`, `pnpm tc`, and `oxlint` all pass.",
  '',
  '## AI Disclosure',
  '',
  'Authored with Claude Code (Claude Fable 5.1 and Sonnet teammates) under my review.',
  '',
  '## Review',
  '',
  "Removes a source-mutating side effect from the details-block markdown serializer: it now writes the styling class into a saved file's `<details>` tag only when the file's source already carried that class, since the class is otherwise applied independently to the rendered DOM node. The unconditional injection was why any file with a details block failed the rich-mode round-trip check and fell back to Source mode; making it conditional both fixes new files and keeps files already saved by Orca round-tripping unchanged. User-provided attributes are unaffected, since blocks with attributes outside the small supported set are treated as opaque passthrough HTML rather than going through this serializer.",
  '',
  '## Agent skill upstream boundary',
  '',
  '- [x] Not applicable, or this change follows `docs/reference/agent-skill-sharing-upstream-boundary.md` and copies or mechanically translates no upstream skill-installer source, tests, fixtures, registry entries, path tables, comments, or documentation.',
  '',
  '## Notes',
  '',
  'Ensure no issues in: Security, Cross-platoform support (Linux, Windows, Mac), Remote SSH, Mobile, general backwards compatibility, performance',
  '',
  '## Checklist',
  '',
  '- [x] This PR is small and focused',
  '- [x] I explained what changed and why (including ELI5)',
  '- [ ] Before/after screenshots or videos attached for UI changes, or `N/A` with reason',
  '- [x] Self-reviewed for correctness, security, and performance',
  '- [x] Cross-platform, SSH/remote, and path/shortcut impact considered (or N/A)',
  '- [x] `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` pass (or CI will cover; local preferred)',
  '',
  '## Author',
  '',
  'X: [@fbartho](https://x.com/fbartho). I prefer Mastodon: [@fbartho@mastodon.social](https://mastodon.social/@fbartho).'
].join('\n')

function roundTripMarkdown(content: string): string {
  const codec = createRichMarkdownEditorCodec()
  const editor = new Editor({
    element: null,
    extensions: createRichMarkdownExtensions({ codec }),
    content: encodeRawMarkdownHtmlForRichEditor(content, codec),
    contentType: 'markdown'
  })

  try {
    return editor.getMarkdown().trimEnd()
  } finally {
    editor.destroy()
  }
}

function markdownAfterTextReplace(content: string, search: string, replacement: string): string {
  const codec = createRichMarkdownEditorCodec()
  const editor = new Editor({
    element: null,
    extensions: createRichMarkdownExtensions({ codec }),
    content: encodeRawMarkdownHtmlForRichEditor(content, codec),
    contentType: 'markdown'
  })

  try {
    let from = -1
    editor.state.doc.descendants((node, pos) => {
      if (from !== -1 || !node.isText || !node.text) {
        return
      }
      const index = node.text.indexOf(search)
      if (index !== -1) {
        from = pos + index
      }
    })
    if (from === -1) {
      throw new Error(`Missing text: ${search}`)
    }
    editor.view.dispatch(editor.state.tr.insertText(replacement, from, from + search.length))
    return editor.getMarkdown().trimEnd()
  } finally {
    editor.destroy()
  }
}

function slashCommandMarkdown(commandId: SlashCommandId): string {
  const codec = createRichMarkdownEditorCodec()
  const editor = new Editor({
    element: null,
    extensions: createRichMarkdownExtensions({ codec }),
    content: '',
    contentType: 'markdown'
  })

  try {
    const command = slashCommands.find((item) => item.id === commandId)
    if (!command) {
      throw new Error(`Missing slash command: ${commandId}`)
    }

    command.run(editor)
    return editor.getMarkdown().trimEnd()
  } finally {
    editor.destroy()
  }
}

function slashCommandSelectionParent(commandId: SlashCommandId): string {
  const codec = createRichMarkdownEditorCodec()
  const editor = new Editor({
    element: null,
    extensions: createRichMarkdownExtensions({ codec }),
    content: '',
    contentType: 'markdown'
  })

  try {
    const command = slashCommands.find((item) => item.id === commandId)
    if (!command) {
      throw new Error(`Missing slash command: ${commandId}`)
    }

    command.run(editor)
    return editor.state.selection.$from.parent.type.name
  } finally {
    editor.destroy()
  }
}

describe('rich markdown round trip', () => {
  it('preserves inline html inside paragraphs', () => {
    expect(roundTripMarkdown('Before <span>hi</span> after\n')).toBe('Before <span>hi</span> after')
  })

  it('preserves mdx-like inline tags', () => {
    expect(roundTripMarkdown('Use <Widget /> today\n')).toBe('Use <Widget /> today')
  })

  it('preserves block html and comments', () => {
    expect(roundTripMarkdown('<div>block</div>\n')).toBe('<div>block</div>')
    expect(roundTripMarkdown('<!-- comment -->\n')).toBe('<!-- comment -->')
  })

  it('preserves editable details blocks', () => {
    expect(roundTripMarkdown('<details><summary>Toggle</summary><p>Body</p></details>\n')).toBe(
      '<details class="orca-details">\n<summary>Toggle</summary>\n\nBody\n\n</details>'
    )
  })

  it('does not double-escape entities in editable details summaries', () => {
    expect(roundTripMarkdown('<details><summary>A &amp; B</summary><p>Body</p></details>\n')).toBe(
      '<details class="orca-details">\n<summary>A &amp; B</summary>\n\nBody\n\n</details>'
    )
  })

  it('preserves heading-styled details blocks', () => {
    expect(
      roundTripMarkdown(
        '<details data-orca-toggle="heading-1"><summary>Toggle</summary><p>Body</p></details>\n'
      )
    ).toBe(
      '<details class="orca-details" data-orca-toggle="heading-1">\n<summary>Toggle</summary>\n\nBody\n\n</details>'
    )
  })

  it.each(['heading-2', 'heading-3', 'heading-4', 'heading-5'])(
    'preserves %s-styled details blocks',
    (variant) => {
      expect(
        roundTripMarkdown(
          `<details data-orca-toggle="${variant}"><summary>Toggle</summary><p>Body</p></details>\n`
        )
      ).toBe(
        `<details class="orca-details" data-orca-toggle="${variant}">\n<summary>Toggle</summary>\n\nBody\n\n</details>`
      )
    }
  )

  it('preserves a heading toggle when its attribute uses HTML whitespace around equals', () => {
    expect(
      roundTripMarkdown(
        '<details data-orca-toggle = "heading-4"><summary>Toggle</summary><p>Body</p></details>\n'
      )
    ).toBe(
      '<details class="orca-details" data-orca-toggle="heading-4">\n<summary>Toggle</summary>\n\nBody\n\n</details>'
    )
  })

  it('preserves details blocks with raw html as passthrough html', () => {
    const input = '<details><summary><span>Toggle</span></summary><p><em>Body</em></p></details>\n'
    expect(roundTripMarkdown(input)).toBe(input.trimEnd())
  })

  it('preserves details blocks with unsupported attributes as passthrough html', () => {
    const input =
      '<details id="x"><summary class="s">Toggle</summary><p data-x="1">Body</p></details>\n'
    expect(roundTripMarkdown(input)).toBe(input.trimEnd())
  })

  it('preserves details blocks with unsupported toggle variants as passthrough html', () => {
    const input =
      '<details data-orca-toggle="heading-6"><summary>Toggle</summary><p>Body</p></details>\n'
    expect(roundTripMarkdown(input)).toBe(input.trimEnd())
  })

  it('preserves details blocks with closing tags inside fenced code as passthrough html', () => {
    const input = [
      '<details><summary>Toggle</summary>',
      '',
      '```',
      '</details>',
      '```',
      '',
      '</details>',
      ''
    ].join('\n')
    expect(roundTripMarkdown(input)).toBe(input.trimEnd())
  })

  it('reopens nested toggles as editable details blocks', () => {
    expect(
      roundTripMarkdown(
        '<details><summary>Outer</summary><details><summary>Inner</summary><p>Body</p></details></details>\n'
      )
    ).toBe(
      [
        '<details class="orca-details">',
        '<summary>Outer</summary>',
        '',
        '<details class="orca-details">',
        '<summary>Inner</summary>',
        '',
        'Body',
        '',
        '</details>',
        '',
        '</details>'
      ].join('\n')
    )
  })

  it('round-trips an orca-authored nested toggle unchanged', () => {
    const input = [
      '<details class="orca-details" data-orca-toggle="heading-3" open>',
      '<summary>08/26/2026</summary>',
      '',
      '<details class="orca-details" open>',
      '<summary>goals</summary>',
      '',
      '- Read X post',
      '  - Collab',
      '',
      '</details>',
      '',
      '- after inner',
      '',
      '</details>',
      ''
    ].join('\n')
    expect(roundTripMarkdown(input)).toBe(input.trimEnd())
  })

  it('keeps nested toggle bodies editable rather than inert raw html', () => {
    const markdown = markdownAfterTextReplace(
      [
        '<details class="orca-details" open>',
        '<summary>Outer</summary>',
        '',
        '<details class="orca-details" open>',
        '<summary>Inner</summary>',
        '',
        'Body',
        '',
        '</details>',
        '',
        '</details>',
        ''
      ].join('\n'),
      'Body',
      'Edited body'
    )
    expect(markdown).toContain('Edited body')
  })

  it('preserves a nested toggle that is not itself editable as passthrough html', () => {
    const input =
      '<details><summary>Outer</summary><details id="x"><summary>Inner</summary><p>Body</p></details></details>\n'
    expect(roundTripMarkdown(input)).toBe(input.trimEnd())
  })

  it('preserves loose details and summary tags as passthrough html', () => {
    expect(roundTripMarkdown('<summary>Loose</summary>\n')).toBe('<summary>Loose</summary>')
    expect(roundTripMarkdown('<details>\n')).toBe('<details>')
  })

  it('preserves a prose mention of <details> inside inline code', () => {
    const input = 'Text with `<details>` inline and a `<summary>` mention.\n'
    expect(roundTripMarkdown(input)).toBe(input.trimEnd())
  })

  it('preserves a fenced code block containing <details>', () => {
    const input = ['```', '<details>', '<summary>Not a block</summary>', '```', ''].join('\n')
    expect(roundTripMarkdown(input)).toBe(input.trimEnd())
  })

  it('keeps a details block intact when its body mentions </details> in a code span', () => {
    // The body text still contains a literal </details>-shaped tag, so
    // isEditableDetailsHtmlBlock keeps this passthrough HTML rather than rich
    // mode — the regression this guards is the tag-depth pairing scan closing
    // the block early at that code-span match and truncating the raw source.
    const input =
      '<details><summary>Toggle</summary><p>See `</details>` for reference and more body text after.</p></details>\n'
    expect(roundTripMarkdown(input)).toBe(input.trimEnd())
  })

  it('round-trips a real-world document with multiple <details> mentions in code spans', () => {
    expect(roundTripMarkdown(REPORT_DOCUMENT_FIXTURE)).toBe(REPORT_DOCUMENT_FIXTURE)
  })

  it('inserts editable text toggles from slash commands', () => {
    expect(slashCommandMarkdown('toggle-text')).toBe(
      '<details class="orca-details" open>\n<summary></summary>\n\n\n\n</details>'
    )
    expect(slashCommandSelectionParent('toggle-text')).toBe('detailsSummary')
  })

  it('inserts editable heading toggles from slash commands', () => {
    expect(slashCommandMarkdown('toggle-h1')).toBe(
      '<details class="orca-details" data-orca-toggle="heading-1" open>\n<summary></summary>\n\n\n\n</details>'
    )
    expect(slashCommandSelectionParent('toggle-h1')).toBe('detailsSummary')
  })

  it.each([
    ['toggle-h2', 'heading-2'],
    ['toggle-h3', 'heading-3'],
    ['toggle-h4', 'heading-4'],
    ['toggle-h5', 'heading-5']
  ] as const)('inserts editable %s toggles from slash commands', (commandId, variant) => {
    expect(slashCommandMarkdown(commandId)).toBe(
      `<details class="orca-details" data-orca-toggle="${variant}" open>\n<summary></summary>\n\n\n\n</details>`
    )
    expect(slashCommandSelectionParent(commandId)).toBe('detailsSummary')
  })

  it('preserves markdown tables', () => {
    expect(roundTripMarkdown('| a | b |\n| - | - |\n| 1 | 2 |\n')).toContain('| a')
  })

  it('preserves encoded local image paths with screenshot filenames', () => {
    expect(roundTripMarkdown('![](Screenshot%202026-06-22%20at%203.37.19%20PM%20copy.png)\n')).toBe(
      '![](Screenshot%202026-06-22%20at%203.37.19%20PM%20copy.png)'
    )
  })

  it('preserves links whose label is inline code', () => {
    expect(roundTripMarkdown('Link to [`foo.md`](./foo.md) here\n')).toBe(
      'Link to [`foo.md`](./foo.md) here'
    )
  })

  it('preserves links whose label is inline code after an editor transaction', () => {
    expect(
      markdownAfterTextReplace('Link to [`foo.md`](./foo.md) here\n', 'here', 'here saved')
    ).toBe('Link to [`foo.md`](./foo.md) here saved')
  })

  it('preserves links when editing inside an inline-code label', () => {
    expect(markdownAfterTextReplace('Link to [`foo.md`](./foo.md) here\n', 'foo', 'bar')).toBe(
      'Link to [`bar.md`](./foo.md) here'
    )
  })

  it('preserves titled links whose label is inline code', () => {
    expect(roundTripMarkdown('Link to [`foo.md`](./foo.md "Foo") here\n')).toBe(
      'Link to [`foo.md`](./foo.md "Foo") here'
    )
  })

  it('preserves bold link labels as formatted link text', () => {
    expect(roundTripMarkdown('Link to [**bold**](./foo.md) here\n')).toBe(
      'Link to [**bold**](./foo.md) here'
    )
  })

  it('does not surface Linear issue reference definitions as description text', () => {
    const input = [
      '- [x] [H-279]',
      '- [ ] [H-284]',
      '',
      '[H-279]: https://linear.app/acme/issue/H-279/child-one "Child one"',
      '[H-284]: https://linear.app/acme/issue/H-284/child-two "Child two"',
      ''
    ].join('\n')

    expect(roundTripMarkdown(input)).toBe(
      [
        '- [x] [H-279](https://linear.app/acme/issue/H-279/child-one "Child one")',
        '- [ ] [H-284](https://linear.app/acme/issue/H-284/child-two "Child two")'
      ].join('\n')
    )
  })

  it('preserves aligned task-item continuations before nested bullets', () => {
    const input = [
      '- [ ] Complete the provider action map used by the',
      '      unchanged UI:',
      '  - review creation and eligibility;',
      '  - merge and auto-merge.',
      '- [ ] Keep provider behavior explicit.'
    ].join('\n')

    expect(roundTripMarkdown(input)).toBe(
      [
        '- [ ] Complete the provider action map used by the',
        '',
        '  unchanged UI:',
        '  - review creation and eligibility;',
        '  - merge and auto-merge.',
        '- [ ] Keep provider behavior explicit.'
      ].join('\n')
    )
  })

  it('preserves blank-separated indented code inside task items', () => {
    expect(roundTripMarkdown('- [ ] Run this:\n\n      echo ok\n')).toContain('```')
  })

  it('preserves doc links', () => {
    expect(roundTripMarkdown('See [[setup-guide]] for details\n')).toBe(
      'See [[setup-guide]] for details'
    )
  })

  it('preserves adjacent doc links', () => {
    expect(roundTripMarkdown('[[one]][[two]]\n')).toBe('[[one]][[two]]')
  })

  it('preserves doc links with paths', () => {
    expect(roundTripMarkdown('Link to [[docs/setup-guide.md]]\n')).toBe(
      'Link to [[docs/setup-guide.md]]'
    )
  })

  it('preserves aliased doc links', () => {
    expect(roundTripMarkdown('Link to [[docs/setup-guide.md|Setup Guide]]\n')).toBe(
      'Link to [[docs/setup-guide.md|Setup Guide]]'
    )
  })

  it('does not encode invalid doc links', () => {
    const result = roundTripMarkdown('Empty [[]] and blank alias [[a|]]\n')
    expect(result).toContain('[[]]')
    expect(result).toContain('[[a|]]')
  })

  it('preserves doc links inside fenced code blocks as plain text', () => {
    const input = '```\n[[not-a-link]]\n```\n'
    expect(roundTripMarkdown(input)).toBe('```\n[[not-a-link]]\n```')
  })
})

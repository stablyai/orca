# URL boundary rendering proof

```sh
ORCA_BACKGROUND_LAUNCH=1 node tests/tools/url-trailing-punctuation-rendered/run.mjs after
```

Renders one Japanese sentence through the production `CommentMarkdown` and the
production `createPaneDOM`, so the native-chat anchor and the terminal pane's
`WebLinksAddon` wiring are the real ones, not a stand-in. The fixture prints the
`href` each anchor resolved to, then the harness moves a real mouse over the
terminal URL so xterm's linkifier and the pane's own tooltip callback run.

Markdown breaks on both bracket widths; the terminal's stock regex already
excluded a half-width `)`, so the terminal sample uses the full-width pair.

For a before/after pair, check the three touched sources out at `upstream/main`,
run with `before`, then restore:

```sh
git checkout upstream/main -- \
  src/renderer/src/components/sidebar/CommentMarkdown.tsx \
  src/renderer/src/lib/pane-manager/pane-dom-creation.ts \
  src/renderer/src/components/dashboard-popout/preview-terminal-links.ts
rm -f src/renderer/src/lib/url-trailing-punctuation.ts \
  src/renderer/src/components/sidebar/comment-markdown-autolink-punctuation.ts
ORCA_BACKGROUND_LAUNCH=1 node tests/tools/url-trailing-punctuation-rendered/run.mjs before
git checkout HEAD -- src/
```

This checks rendered link boundaries, not routing or the full Orca shell; the
boundary rules themselves are covered by `url-trailing-punctuation.test.ts` and
`CommentMarkdown.autolink-punctuation.test.tsx`. Screenshots and a report land
under `.bench-fixtures/url-trailing-punctuation-*`; every native window must
stay hidden and unfocused.

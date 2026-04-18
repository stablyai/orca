import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { findTextMatchRanges } from './markdown-preview-search';
export const richMarkdownSearchPluginKey = new PluginKey('richMarkdownSearch');
export function findRichMarkdownSearchMatches(doc, query) {
    if (!query) {
        return [];
    }
    const matches = [];
    doc.descendants((node, pos) => {
        if (!node.isText) {
            return;
        }
        const text = node.text ?? '';
        if (!text.trim()) {
            return;
        }
        const ranges = findTextMatchRanges(text, query);
        for (const range of ranges) {
            matches.push({
                from: pos + range.start,
                to: pos + range.end
            });
        }
    });
    return matches;
}
export function createRichMarkdownSearchPlugin() {
    return new Plugin({
        key: richMarkdownSearchPluginKey,
        state: {
            init: () => ({
                activeIndex: -1,
                decorations: DecorationSet.empty,
                query: ''
            }),
            apply: (tr, pluginState) => {
                const meta = tr.getMeta(richMarkdownSearchPluginKey);
                const query = meta?.query ?? pluginState.query;
                const activeIndex = meta?.activeIndex ?? pluginState.activeIndex;
                if (!query) {
                    return {
                        activeIndex: -1,
                        decorations: DecorationSet.empty,
                        query: ''
                    };
                }
                if (!meta && !tr.docChanged) {
                    return pluginState;
                }
                return {
                    activeIndex,
                    decorations: buildSearchDecorations(tr.doc, query, activeIndex),
                    query
                };
            }
        },
        props: {
            decorations(state) {
                return richMarkdownSearchPluginKey.getState(state)?.decorations ?? DecorationSet.empty;
            }
        }
    });
}
function buildSearchDecorations(doc, query, activeIndex) {
    const matches = findRichMarkdownSearchMatches(doc, query);
    if (matches.length === 0) {
        return DecorationSet.empty;
    }
    const decorations = matches.map((match, index) => Decoration.inline(match.from, match.to, {
        class: 'rich-markdown-search-match',
        'data-active': index === activeIndex ? 'true' : undefined
    }));
    return DecorationSet.create(doc, decorations);
}

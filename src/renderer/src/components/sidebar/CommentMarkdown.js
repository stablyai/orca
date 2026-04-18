import { jsx as _jsx } from "react/jsx-runtime";
import React from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { cn } from '@/lib/utils';
// Why: sidebar comments are rendered at 11px in a narrow card, so we strip
// block-level wrappers that add unwanted margins and only keep inline
// formatting (bold, italic, code, links) plus compact lists and line breaks.
// Using react-markdown (already a project dependency) lets AI agents write
// markdown via `orca worktree set --comment` and have it render nicely.
const components = {
    // Strip <p> wrappers to avoid double margins in the tight card layout.
    p: ({ children }) => _jsx("span", { className: "comment-md-p", children: children }),
    // Open links externally — sidebar is not a navigation context.
    a: ({ href, children }) => (_jsx("a", { href: href, target: "_blank", rel: "noreferrer", className: "underline underline-offset-2 text-foreground/80 hover:text-foreground", onClick: (e) => e.stopPropagation(), children: children })),
    // Why: react-markdown calls the `code` component for both inline `code`
    // and the <code> inside fenced blocks (<pre><code>…</code></pre>). We
    // always apply inline-code styling here; the wrapper div uses a CSS
    // descendant selector ([&_pre_code]) at higher specificity to strip
    // the pill background/padding when code is inside a <pre>. This is
    // more reliable than checking `className` — which is only set when
    // the fenced block specifies a language (```js), not for bare ```.
    code: ({ children }) => (_jsx("code", { className: "rounded bg-accent px-1 py-px text-[10px] font-mono", children: children })),
    // Compact pre blocks — no syntax highlighting needed for short comments
    pre: ({ children }) => (_jsx("pre", { className: "my-1 rounded bg-accent p-1.5 text-[10px] font-mono overflow-x-auto max-h-32", children: children })),
    // Compact lists
    ul: ({ children }) => _jsx("ul", { className: "my-0.5 ml-3 list-disc space-y-0", children: children }),
    ol: ({ children }) => _jsx("ol", { className: "my-0.5 ml-3 list-decimal space-y-0", children: children }),
    // Why: GFM task list checkboxes are non-functional in a read-only comment
    // card (clicking them would just open the edit modal via the parent's
    // onClick). Rendering them disabled avoids a misleading interactive
    // affordance.
    li: ({ children }) => (_jsx("li", { className: "leading-normal [&>input]:pointer-events-none", children: children })),
    // Headings render as bold text at the same size — no visual hierarchy needed
    // in a tiny sidebar card.
    h1: ({ children }) => _jsx("span", { className: "font-bold", children: children }),
    h2: ({ children }) => _jsx("span", { className: "font-bold", children: children }),
    h3: ({ children }) => _jsx("span", { className: "font-semibold", children: children }),
    h4: ({ children }) => _jsx("span", { className: "font-semibold", children: children }),
    h5: ({ children }) => _jsx("span", { className: "font-semibold", children: children }),
    h6: ({ children }) => _jsx("span", { className: "font-semibold", children: children }),
    // Horizontal rules as a subtle divider
    hr: () => _jsx("hr", { className: "my-1 border-border/50" }),
    // Compact blockquotes
    blockquote: ({ children }) => (_jsx("blockquote", { className: "my-0.5 border-l-2 border-border/60 pl-2 text-muted-foreground/80", children: children })),
    // Why: images in a ~200px sidebar card would blow out the layout or look
    // broken at any reasonable size. Render as a text link instead so the URL is
    // still accessible without disrupting the card.
    img: ({ alt, src }) => (_jsx("a", { href: src, target: "_blank", rel: "noreferrer", className: "underline underline-offset-2 text-foreground/80 hover:text-foreground", onClick: (e) => e.stopPropagation(), children: alt || 'image' })),
    // Why: GFM tables in a ~200px sidebar would overflow badly. Wrapping in an
    // overflow container keeps the card layout stable while still letting the
    // user scroll to see the full table.
    table: ({ children }) => (_jsx("div", { className: "my-1 overflow-x-auto", children: _jsx("table", { className: "text-[10px] border-collapse [&_td]:border [&_td]:border-border/40 [&_td]:px-1 [&_td]:py-0.5 [&_th]:border [&_th]:border-border/40 [&_th]:px-1 [&_th]:py-0.5 [&_th]:font-semibold [&_th]:text-left", children: children }) }))
};
// Why: standard CommonMark collapses single newlines into spaces. The old
// plain-text renderer used whitespace-pre-wrap which preserved them. Adding
// remark-breaks converts single newlines to <br>, keeping backward compat
// with existing plain-text comments that rely on newline formatting.
const remarkPlugins = [remarkGfm, remarkBreaks];
// Why forwardRef + rest props: Radix's HoverCardTrigger asChild merges a ref
// and event handlers (onPointerEnter, onPointerLeave, data-state, etc.) onto
// the child. Without forwarding both, the hover card cannot open or position.
const CommentMarkdown = React.memo(React.forwardRef(function CommentMarkdown({ content, className, ...rest }, ref) {
    return (_jsx("div", { ref: ref, className: cn(
        // Reset inline-code pill styles when <code> is inside a <pre> block.
        // The descendant selector (pre code) has higher specificity than the
        // direct utility classes on <code>, so these overrides win reliably.
        '[&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:rounded-none', className), ...rest, children: _jsx(Markdown, { remarkPlugins: remarkPlugins, components: components, children: content }) }));
}));
export default CommentMarkdown;

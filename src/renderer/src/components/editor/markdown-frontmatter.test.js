import { describe, expect, it } from 'vitest';
import { extractFrontMatter, prependFrontMatter } from './markdown-frontmatter';
describe('extractFrontMatter', () => {
    it('extracts YAML front-matter delimited by ---', () => {
        const content = '---\ntitle: Hello\ntags: [a, b]\n---\n# Body\n';
        const result = extractFrontMatter(content);
        expect(result).not.toBeNull();
        expect(result.raw).toBe('---\ntitle: Hello\ntags: [a, b]\n---\n');
        expect(result.body).toBe('# Body\n');
    });
    it('extracts TOML front-matter delimited by +++', () => {
        const content = '+++\ntitle = "Hello"\n+++\nBody\n';
        const result = extractFrontMatter(content);
        expect(result).not.toBeNull();
        expect(result.raw).toBe('+++\ntitle = "Hello"\n+++\n');
        expect(result.body).toBe('Body\n');
    });
    it('returns null when there is no front-matter', () => {
        expect(extractFrontMatter('# Just a heading\n')).toBeNull();
        expect(extractFrontMatter('')).toBeNull();
    });
    it('does not match --- in the middle of the document', () => {
        const content = '# Title\n\n---\nkey: val\n---\n';
        expect(extractFrontMatter(content)).toBeNull();
    });
    it('handles front-matter with no body', () => {
        const content = '---\ntitle: Hello\n---\n';
        const result = extractFrontMatter(content);
        expect(result).not.toBeNull();
        expect(result.body).toBe('');
    });
    it('handles CRLF line endings', () => {
        const content = '---\r\ntitle: Hello\r\n---\r\n# Body\r\n';
        const result = extractFrontMatter(content);
        expect(result).not.toBeNull();
        expect(result.body).toBe('# Body\r\n');
    });
    it('handles empty front-matter block', () => {
        const content = '---\n\n---\n# Body\n';
        const result = extractFrontMatter(content);
        expect(result).not.toBeNull();
        expect(result.raw).toBe('---\n\n---\n');
        expect(result.body).toBe('# Body\n');
    });
});
describe('prependFrontMatter', () => {
    it('reassembles front-matter and body', () => {
        const raw = '---\ntitle: Hello\n---\n';
        const body = '# Body\n';
        expect(prependFrontMatter(raw, body)).toBe('---\ntitle: Hello\n---\n# Body\n');
    });
    it('adds trailing newline to raw if missing', () => {
        const raw = '---\ntitle: Hello\n---';
        const body = '# Body\n';
        expect(prependFrontMatter(raw, body)).toBe('---\ntitle: Hello\n---\n# Body\n');
    });
    it('round-trips with extractFrontMatter', () => {
        const original = '---\ntitle: Hello\ntags: [a, b]\n---\n# Body\n\nParagraph.\n';
        const fm = extractFrontMatter(original);
        expect(fm).not.toBeNull();
        expect(prependFrontMatter(fm.raw, fm.body)).toBe(original);
    });
});
